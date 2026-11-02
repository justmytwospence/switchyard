import type { AuthMethods, Device, OidcBeginResponse } from "@switchyard/protocol";
import { SwitchyardError } from "@switchyard/protocol";
import * as client from "openid-client";
import { type Auth, newToken, safeEqualHex, sha256 } from "./auth.js";
import type { CoordinatorConfig, OidcConfig } from "./context.js";
import { AuthFlows, newFlowId, type Owner } from "./owner.js";
import type { Store } from "./store.js";

export const OIDC_FLOW_TTL_MS = 10 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 30_000;
export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

interface OidcFlow {
  verifier: string;
  nonce: string;
  deviceName: string;
  kind: "browser" | "pwa";
  next: string;
  handoff: boolean;
  pollTokenHash: string | null;
  result: { deviceId: string; credentialEnc: string } | null;
}

export type OidcCallbackResult =
  | { mode: "direct"; deviceId: string; credential: string; next: string }
  | { mode: "handoff" };

export type OidcClaimResult =
  | { status: "pending" }
  | { status: "done"; deviceId: string; credential: string };

type Claims = Record<string, unknown>;

/** Readable owner criteria, e.g. `email me@example.com and group admins`. */
export function describeOwnerMatch(owner: OidcConfig["owner"]): string {
  const parts: string[] = [];
  if (owner.subject) parts.push(`subject ${owner.subject}`);
  if (owner.email) parts.push(`email ${owner.email}`);
  if (owner.group) parts.push(`group ${owner.group}`);
  return parts.join(" and ");
}

export function hasOwnerMatch(owner: OidcConfig["owner"]): boolean {
  return !!(owner.subject || owner.email || owner.group);
}

/** `next` must be a same-origin path: starts with `/`, not `//` (or `/\`). Otherwise `/`. */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

/** Every configured criterion must hold. */
export function ownerMatches(owner: OidcConfig["owner"], claims: Claims): boolean {
  if (owner.subject && claims.sub !== owner.subject) return false;
  if (owner.email) {
    const email = typeof claims.email === "string" ? claims.email : null;
    if (!email || email.toLowerCase() !== owner.email.toLowerCase()) return false;
    if (claims.email_verified === false) return false;
  }
  if (owner.group) {
    const groups = claims.groups;
    if (!Array.isArray(groups) || !groups.includes(owner.group)) return false;
  }
  return true;
}

function isLoopbackHttp(issuer: URL): boolean {
  const host = issuer.hostname.replace(/^\[|\]$/g, "");
  return issuer.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host);
}

/** Owner sign-in through any OpenID Connect provider (authorization code + PKCE). */
export class Oidc {
  private readonly flows: AuthFlows;
  private discovered: Promise<client.Configuration> | null = null;
  private failure: { message: string; at: number } | null = null;

  constructor(
    store: Store,
    _owner: Owner,
    private readonly config: CoordinatorConfig,
    private readonly auth: Auth,
  ) {
    this.flows = new AuthFlows(store);
  }

  private get oidc(): OidcConfig {
    if (!this.config.oidc) {
      throw new SwitchyardError(
        "unsupported_capability",
        "Single sign-on is not configured on this server",
      );
    }
    return this.config.oidc;
  }

  private get redirectUri(): string {
    return `${this.config.publicUrl}${OIDC_CALLBACK_PATH}`;
  }

  /** Discovery, lazy and cached; a failure is cached for 30 seconds. */
  async configuration(): Promise<client.Configuration> {
    const o = this.oidc;
    const now = Date.now();
    if (this.failure && now - this.failure.at < DISCOVERY_FAILURE_TTL_MS) {
      throw new SwitchyardError("host_unreachable", this.failure.message);
    }
    if (!this.discovered) {
      const issuer = new URL(o.issuer);
      this.discovered = client
        .discovery(
          issuer,
          o.clientId,
          o.clientSecret ?? undefined,
          o.clientSecret ? client.ClientSecretBasic(o.clientSecret) : client.None(),
          isLoopbackHttp(issuer) ? { execute: [client.allowInsecureRequests] } : undefined,
        )
        .then(
          (cfg) => {
            this.failure = null;
            return cfg;
          },
          (err) => {
            const message = `Single sign-on provider ${o.issuer} is unavailable: ${(err as Error).message}`;
            this.failure = { message, at: Date.now() };
            this.discovered = null;
            throw new SwitchyardError("host_unreachable", message);
          },
        );
    }
    return this.discovered;
  }

  async begin(input: {
    deviceName: string;
    kind: "browser" | "pwa";
    next?: string;
    handoff: boolean;
  }): Promise<OidcBeginResponse> {
    const o = this.oidc;
    const cfg = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const nonce = client.randomNonce();
    const flowId = newFlowId();
    const pollToken = input.handoff ? newToken() : null;
    const flow: OidcFlow = {
      verifier,
      nonce,
      deviceName: input.deviceName,
      kind: input.kind,
      next: safeNext(input.next),
      handoff: input.handoff,
      pollTokenHash: pollToken ? sha256(pollToken) : null,
      result: null,
    };
    this.flows.put("oidc", flowId, flow, OIDC_FLOW_TTL_MS);
    const authorizeUrl = client.buildAuthorizationUrl(cfg, {
      redirect_uri: this.redirectUri,
      scope: o.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: flowId,
      nonce,
    });
    return {
      authorizeUrl: authorizeUrl.href,
      flowId: input.handoff ? flowId : null,
      pollToken,
    };
  }

  /** Complete the authorization code flow for the callback URL as the browser requested it. */
  async callback(currentUrl: URL): Promise<OidcCallbackResult> {
    const o = this.oidc;
    const state = currentUrl.searchParams.get("state");
    const flow = state ? this.flows.get<OidcFlow>("oidc", state) : null;
    if (!state || !flow || flow.result) {
      throw new SwitchyardError("invalid_request", "This sign-in expired or was already used");
    }
    // Single use: a replayed callback finds no flow (handoff flows stay for the claim).
    if (!flow.handoff) this.flows.delete(state);
    const cfg = await this.configuration();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: state,
        expectedNonce: flow.nonce,
      });
    } catch (err) {
      if (flow.handoff) this.flows.delete(state);
      throw err;
    }
    const idClaims = (tokens.claims() ?? {}) as Claims;
    let claims: Claims = { ...idClaims };
    if (typeof idClaims.sub === "string") {
      try {
        const info = (await client.fetchUserInfo(cfg, tokens.access_token, idClaims.sub)) as Claims;
        claims = { ...idClaims, ...info };
      } catch (err) {
        // Fine when the ID token already carries what the owner match needs.
        const needs =
          (o.owner.email && typeof idClaims.email !== "string") ||
          (o.owner.group && !Array.isArray(idClaims.groups));
        if (needs) {
          if (flow.handoff) this.flows.delete(state);
          throw new SwitchyardError(
            "forbidden",
            `Could not read your profile from the provider: ${(err as Error).message}`,
          );
        }
      }
    }
    if (!ownerMatches(o.owner, claims)) {
      if (flow.handoff) this.flows.delete(state);
      const who = String(claims.preferred_username ?? claims.email ?? claims.sub ?? "unknown");
      throw new SwitchyardError(
        "forbidden",
        `Signed in as ${who} (subject ${String(claims.sub)}), which is not this server's owner.`,
      );
    }
    const { device, credential } = this.auth.createDevice(
      flow.deviceName,
      flow.kind satisfies Device["kind"],
      "oidc",
    );
    if (!flow.handoff) {
      return { mode: "direct", deviceId: device.id, credential, next: flow.next };
    }
    this.flows.update(state, {
      ...flow,
      result: { deviceId: device.id, credentialEnc: credential },
    });
    return { mode: "handoff" };
  }

  /** PWA handoff: claim the device minted in another browser with the one-time poll token. */
  claim(flowId: string, pollToken: string): OidcClaimResult {
    const flow = this.flows.get<OidcFlow>("oidc", flowId);
    if (
      !flow?.handoff ||
      !flow.pollTokenHash ||
      !safeEqualHex(sha256(pollToken), flow.pollTokenHash)
    ) {
      throw new SwitchyardError("unauthorized", "Unknown or expired sign-in");
    }
    if (!flow.result) return { status: "pending" };
    this.flows.delete(flowId);
    return {
      status: "done",
      deviceId: flow.result.deviceId,
      credential: flow.result.credentialEnc,
    };
  }

  /** Status for Settings › Sign-in (triggers discovery). */
  async describe(): Promise<NonNullable<AuthMethods["oidc"]>> {
    const o = this.oidc;
    let error: string | null = null;
    try {
      await this.configuration();
    } catch (err) {
      error = (err as Error).message;
    }
    return {
      issuer: o.issuer,
      label: o.label,
      ownerMatch: describeOwnerMatch(o.owner),
      status: error ? "error" : "ready",
      error,
    };
  }
}
