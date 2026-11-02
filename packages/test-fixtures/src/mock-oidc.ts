import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface MockOidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
  preferred_username?: string;
}

export interface MockOidcOptions {
  claims: MockOidcClaims;
  /**
   * Put every claim in the ID token. Default false: the ID token carries only `sub`, and email,
   * groups and the username come from userinfo (Authelia's default).
   */
  idTokenClaimsOnly?: boolean;
  /** Make `/userinfo` answer 500. */
  failUserinfo?: boolean;
}

export interface MockOidcTokenRequest {
  clientId: string | null;
  /** How the client authenticated at the token endpoint. */
  auth: "client_secret_basic" | "client_secret_post" | "none";
  redirectUri: string | null;
}

export interface MockOidc {
  /** Issuer URL (`http://127.0.0.1:<port>`). */
  issuer: string;
  /** Claims for codes issued from now on. */
  setClaims(claims: MockOidcClaims): void;
  /** Token requests received so far. */
  tokenRequests: MockOidcTokenRequest[];
  close(): Promise<void>;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  challenge: string | null;
  claims: MockOidcClaims;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A minimal auto-approving OpenID Connect provider for tests: discovery, JWKS, `/authorize`
 * (redirects straight back with a code), `/token` (checks PKCE S256, returns an RS256 ID token
 * with the nonce) and `/userinfo`.
 */
export async function startMockOidc(opts: MockOidcOptions): Promise<MockOidc> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  let claims = opts.claims;
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, MockOidcClaims>();
  const tokenRequests: MockOidcTokenRequest[] = [];
  let issuer = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => send(res, 500, { error: String(err) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", issuer);
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        scopes_supported: ["openid", "profile", "email", "groups"],
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      return send(res, 200, { keys: [jwk] });
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const p = url.searchParams;
      const redirectUri = p.get("redirect_uri");
      const clientId = p.get("client_id");
      if (!redirectUri || !clientId || p.get("response_type") !== "code") {
        return send(res, 400, { error: "invalid_request" });
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(code, {
        clientId,
        redirectUri,
        nonce: p.get("nonce"),
        challenge: p.get("code_challenge_method") === "S256" ? p.get("code_challenge") : null,
        claims,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      const state = p.get("state");
      if (state) back.searchParams.set("state", state);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      let clientId = form.get("client_id");
      let auth: MockOidcTokenRequest["auth"] = form.get("client_secret")
        ? "client_secret_post"
        : "none";
      const basic = req.headers.authorization;
      if (basic?.startsWith("Basic ")) {
        auth = "client_secret_basic";
        const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
        clientId = decodeURIComponent(decoded.slice(0, decoded.indexOf(":")));
      }
      tokenRequests.push({ clientId, auth, redirectUri: form.get("redirect_uri") });
      const code = form.get("code") ?? "";
      const issued = codes.get(code);
      codes.delete(code);
      if (form.get("grant_type") !== "authorization_code" || !issued) {
        return send(res, 400, { error: "invalid_grant" });
      }
      if (issued.redirectUri !== form.get("redirect_uri") || issued.clientId !== clientId) {
        return send(res, 400, { error: "invalid_grant", error_description: "client mismatch" });
      }
      if (issued.challenge) {
        const verifier = form.get("code_verifier") ?? "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (computed !== issued.challenge) {
          return send(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        }
      }
      const accessToken = randomBytes(24).toString("base64url");
      accessTokens.set(accessToken, issued.claims);
      const idClaims: Record<string, unknown> = opts.idTokenClaimsOnly
        ? { ...issued.claims }
        : { sub: issued.claims.sub };
      if (issued.nonce) idClaims.nonce = issued.nonce;
      const idToken = await new SignJWT(idClaims)
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer(issuer)
        .setAudience(issued.clientId)
        .setSubject(issued.claims.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return send(res, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken,
      });
    }
    if (url.pathname === "/userinfo") {
      if (opts.failUserinfo) return send(res, 500, { error: "server_error" });
      const h = req.headers.authorization ?? "";
      const c = h.startsWith("Bearer ") ? accessTokens.get(h.slice(7)) : undefined;
      if (!c) return send(res, 401, { error: "invalid_token" });
      return send(res, 200, { ...c });
    }
    send(res, 404, { error: "not_found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    tokenRequests,
    setClaims(c) {
      claims = c;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
