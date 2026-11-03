import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import type { AttentionService } from "./attention.js";
import type { Auth } from "./auth.js";
import type { ClientHub } from "./client-hub.js";
import type { EventHub } from "./event-hub.js";
import type { HostHub } from "./host-hub.js";
import type { Oidc } from "./oidc.js";
import type { Owner } from "./owner.js";
import type { Passkeys } from "./passkeys.js";
import type { RateLimiter } from "./rate-limit.js";
import type { Store } from "./store.js";
import type { TerminalLogins } from "./terminal-login.js";

/** The coordinator package version (read from its package.json). */
export const COORDINATOR_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Generic OIDC owner sign-in (see docs/auth.md). */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** Button label on the sign-in page. */
  label: string;
  /** Space-separated scopes. */
  scopes: string;
  /** Every configured criterion must hold; at least one is required. */
  owner: { subject: string | null; email: string | null; group: string | null };
}

export interface CoordinatorConfig {
  dataDir: string;
  /** Public base URL without trailing slash, e.g. `https://switchyard.example.com`. */
  publicUrl: string;
  /** Origins accepted for cookie-authenticated mutations and browser WebSockets. */
  trustedOrigins: string[];
  webDist: string | null;
  /** True when `publicUrl` is https (cookie `Secure`). */
  secureCookies: boolean;
  /** Host goes from reconnecting to unreachable after this long (default 60 s). */
  unreachableAfterMs: number;
  /** Client presence foreground lease (default 45 s). */
  foregroundLeaseMs: number;
  /** Default timeout for host commands (default 30 s). */
  commandTimeoutMs: number;
  /** Shared host enrollment secret (enables `POST /api/hosts/enroll {secret}`), or null. */
  hostEnrollSecret: string | null;
  /** Owner sign-in through an OIDC provider, or null. */
  oidc: OidcConfig | null;
}

/**
 * Everything a route or service needs. Later workers register extra services in `services`
 * (e.g. `services.set("dispatcher", dispatcher)`) and subscribe to `hub` events.
 */
export interface CoordinatorContext {
  config: CoordinatorConfig;
  store: Store;
  hub: EventHub;
  hostHub: HostHub;
  clientHub: ClientHub;
  auth: Auth;
  attention: AttentionService;
  owner: Owner;
  passkeys: Passkeys;
  oidc: Oidc | null;
  terminalLogins: TerminalLogins;
  limiters: { auth: RateLimiter; hosts: RateLimiter };
  log: Logger;
  services: Map<string, unknown>;
}
