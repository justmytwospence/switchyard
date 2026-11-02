import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { CoordinatorConfig } from "./context.js";
import type { Store } from "./store.js";

export const OWNER_INITIALIZED_KEY = "owner.initialized_at";
export const OWNER_WEBAUTHN_USER_KEY = "owner.webauthn_user_id";

export interface PasskeyAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * The single owner of this server. A server is "initialized" once the owner created the first
 * sign-in (`switchyard init`, `pair`, any enrollment from a device) or declared an OIDC owner.
 */
export class Owner {
  constructor(
    private readonly store: Store,
    private readonly config: CoordinatorConfig,
  ) {}

  isInitialized(): boolean {
    return (
      this.config.oidc !== null ||
      this.store.getSetting<string | null>(OWNER_INITIALIZED_KEY, null) !== null
    );
  }

  /** Mark the server set up. Returns true when this call set it. */
  markInitialized(): boolean {
    return this.store.tx(() => {
      if (this.store.getSetting<string | null>(OWNER_INITIALIZED_KEY, null) !== null) return false;
      this.store.setSetting(OWNER_INITIALIZED_KEY, this.store.nowIso());
      return true;
    });
  }

  /** Stable random WebAuthn user handle for the owner (16 bytes, created lazily). */
  webauthnUserId(): Uint8Array {
    return this.store.tx(() => {
      let id = this.store.getSetting<string | null>(OWNER_WEBAUTHN_USER_KEY, null);
      if (!id) {
        id = randomBytes(16).toString("base64url");
        this.store.setSetting(OWNER_WEBAUTHN_USER_KEY, id);
      }
      return new Uint8Array(Buffer.from(id, "base64url"));
    });
  }

  /** WebAuthn relying party ID: the public URL's hostname. */
  rpId(): string {
    return new URL(this.config.publicUrl).hostname;
  }

  passkeyAvailability(): PasskeyAvailability {
    const url = new URL(this.config.publicUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) {
      return {
        available: false,
        reason: "Passkeys need a domain name (or localhost) in the public URL",
      };
    }
    if (url.protocol !== "https:" && host !== "localhost") {
      return { available: false, reason: "Passkeys need HTTPS" };
    }
    return { available: true, reason: null };
  }
}

export type AuthFlowKind = "passkey_register" | "passkey_auth" | "oidc";

/** Short-lived sign-in state (passkey challenges, OIDC flows) in the `auth_flows` table. */
export class AuthFlows {
  constructor(private readonly store: Store) {}

  /** Store a flow; also drops expired ones. */
  put(kind: AuthFlowKind, id: string, data: unknown, ttlMs: number): void {
    const now = this.store.now();
    this.store.tx(() => {
      this.store.st.get("DELETE FROM auth_flows WHERE expires_at <= ?").run(now.toISOString());
      this.store.st
        .get("INSERT INTO auth_flows (id, kind, data, expires_at) VALUES (?, ?, ?, ?)")
        .run(id, kind, JSON.stringify(data), new Date(now.getTime() + ttlMs).toISOString());
    });
  }

  /** A live (unexpired) flow of `kind`, or null. */
  get<T>(kind: AuthFlowKind, id: string): T | null {
    const row = this.store.st
      .get("SELECT data, expires_at FROM auth_flows WHERE id = ? AND kind = ?")
      .get(id, kind) as { data: string; expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= this.store.now().getTime()) {
      this.delete(id);
      return null;
    }
    return JSON.parse(row.data) as T;
  }

  /** Read and delete a flow (single use). Null when unknown or expired. */
  take<T>(kind: AuthFlowKind, id: string): T | null {
    return this.store.tx(() => {
      const data = this.get<T>(kind, id);
      if (data !== null) this.delete(id);
      return data;
    });
  }

  update(id: string, data: unknown): void {
    this.store.st.get("UPDATE auth_flows SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
  }

  delete(id: string): void {
    this.store.st.get("DELETE FROM auth_flows WHERE id = ?").run(id);
  }
}

/** Random flow / challenge identifier (24 bytes, base64url). */
export function newFlowId(): string {
  return randomBytes(24).toString("base64url");
}
