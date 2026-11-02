import type { Logger } from "pino";
import type { AttentionService } from "./attention.js";
import type { Auth } from "./auth.js";
import type { ClientHub } from "./client-hub.js";
import type { EventHub } from "./event-hub.js";
import type { HostHub } from "./host-hub.js";
import type { Store } from "./store.js";

export const COORDINATOR_VERSION = "0.1.0";

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
  log: Logger;
  services: Map<string, unknown>;
}
