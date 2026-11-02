import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Device, type Passkey, SwitchyardError } from "@switchyard/protocol";
import type { Auth } from "./auth.js";
import type { CoordinatorConfig } from "./context.js";
import { AuthFlows, newFlowId, type Owner } from "./owner.js";
import type { Store } from "./store.js";

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface ChallengeFlow {
  challenge: string;
}

function toPasskey(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    transports: JSON.parse(r.transports) as string[],
  };
}

const EXPIRED = "This passkey request expired; try again";

/** Owner passkeys (discoverable WebAuthn credentials). A passkey sign-in mints a device. */
export class Passkeys {
  private readonly flows: AuthFlows;

  constructor(
    private readonly store: Store,
    private readonly owner: Owner,
    private readonly config: CoordinatorConfig,
    private readonly auth: Auth,
  ) {
    this.flows = new AuthFlows(store);
  }

  private requireAvailable(): string {
    const a = this.owner.passkeyAvailability();
    if (!a.available) {
      throw new SwitchyardError("unsupported_capability", a.reason ?? "Passkeys are unavailable");
    }
    return this.owner.rpId();
  }

  private rows(): PasskeyRow[] {
    return this.store.st
      .get("SELECT * FROM passkeys ORDER BY created_at, id")
      .all() as unknown as PasskeyRow[];
  }

  private row(id: string): PasskeyRow | undefined {
    return this.store.st.get("SELECT * FROM passkeys WHERE id = ?").get(id) as
      | PasskeyRow
      | undefined;
  }

  count(): number {
    return (this.store.st.get("SELECT COUNT(*) AS n FROM passkeys").get() as { n: number }).n;
  }

  list(): Passkey[] {
    return this.rows().map(toPasskey);
  }

  remove(id: string): void {
    const n = this.store.st.get("DELETE FROM passkeys WHERE id = ?").run(id).changes;
    if (Number(n) === 0) throw new SwitchyardError("not_found", `Passkey ${id} not found`);
  }

  async registerOptions(): Promise<{ challengeId: string; options: unknown }> {
    const rpID = this.requireAvailable();
    const options = await generateRegistrationOptions({
      rpName: "Switchyard",
      rpID,
      userName: "owner",
      userDisplayName: "Switchyard owner",
      userID: this.owner.webauthnUserId() as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials: this.rows().map((r) => ({
        id: r.id,
        transports: JSON.parse(r.transports) as string[],
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = newFlowId();
    this.flows.put(
      "passkey_register",
      challengeId,
      { challenge: options.challenge } satisfies ChallengeFlow,
      PASSKEY_CHALLENGE_TTL_MS,
    );
    return { challengeId, options };
  }

  async registerVerify(challengeId: string, name: string, response: unknown): Promise<Passkey> {
    const rpID = this.requireAvailable();
    const flow = this.flows.take<ChallengeFlow>("passkey_register", challengeId);
    if (!flow) throw new SwitchyardError("invalid_request", EXPIRED);
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.config.trustedOrigins,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new SwitchyardError(
        "invalid_request",
        `Passkey registration failed: ${(err as Error).message}`,
      );
    }
    if (!verified.verified) {
      throw new SwitchyardError("invalid_request", "Passkey registration could not be verified");
    }
    const cred = verified.registrationInfo.credential;
    const transports =
      (response as RegistrationResponseJSON).response?.transports ?? cred.transports ?? [];
    if (this.row(cred.id)) {
      throw new SwitchyardError("conflict", "This passkey is already registered");
    }
    const row: PasskeyRow = {
      id: cred.id,
      public_key: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter,
      transports: JSON.stringify(transports),
      name,
      created_at: this.store.nowIso(),
      last_used_at: null,
    };
    this.store.st
      .get(
        "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.public_key,
        row.counter,
        row.transports,
        row.name,
        row.created_at,
        row.last_used_at,
      );
    return toPasskey(row);
  }

  async signInOptions(): Promise<{ challengeId: string; options: unknown }> {
    if (this.count() === 0) {
      throw new SwitchyardError(
        "unsupported_capability",
        "No passkey is registered on this server yet",
      );
    }
    const rpID = this.requireAvailable();
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    const challengeId = newFlowId();
    this.flows.put(
      "passkey_auth",
      challengeId,
      { challenge: options.challenge } satisfies ChallengeFlow,
      PASSKEY_CHALLENGE_TTL_MS,
    );
    return { challengeId, options };
  }

  async signInVerify(
    challengeId: string,
    response: unknown,
    deviceName: string,
    kind: Device["kind"],
  ): Promise<{ device: Device; credential: string }> {
    const rpID = this.requireAvailable();
    const flow = this.flows.take<ChallengeFlow>("passkey_auth", challengeId);
    if (!flow) throw new SwitchyardError("invalid_request", EXPIRED);
    const res = response as AuthenticationResponseJSON;
    const row = typeof res?.id === "string" ? this.row(res.id) : undefined;
    if (!row) throw new SwitchyardError("unauthorized", "This passkey is not registered here");
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response: res,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.config.trustedOrigins,
        expectedRPID: rpID,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
          counter: row.counter,
          transports: JSON.parse(row.transports) as string[],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new SwitchyardError(
        "unauthorized",
        `Passkey sign-in failed: ${(err as Error).message}`,
      );
    }
    if (!verified.verified) {
      throw new SwitchyardError("unauthorized", "Passkey sign-in could not be verified");
    }
    return this.store.tx(() => {
      this.store.st
        .get("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
        .run(verified.authenticationInfo.newCounter, this.store.nowIso(), row.id);
      return this.auth.createDevice(deviceName, kind, "passkey");
    });
  }
}
