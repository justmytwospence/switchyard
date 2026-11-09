import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { DEFAULT_PORT, SwitchyardError } from "@switchyard/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { AttentionService } from "./attention.js";
import { Auth } from "./auth.js";
import { type BuiltinOptions, installBuiltins } from "./builtins.js";
import { ClientHub } from "./client-hub.js";
import type { CoordinatorConfig, CoordinatorContext, OidcConfig } from "./context.js";
import { type Db, migrate, openDb } from "./db/index.js";
import { EventHub } from "./event-hub.js";
import { HostHub } from "./host-hub.js";
import { installErrorHandler } from "./http.js";
import { createLogger } from "./logger.js";
import { hasOwnerMatch, Oidc } from "./oidc.js";
import { acquireLock, dbPath, releaseLock } from "./ops.js";
import { isLoopbackUrl, Owner } from "./owner.js";
import { Passkeys } from "./passkeys.js";
import { AUTH_RATE_LIMIT, HOSTS_RATE_LIMIT, RateLimiter } from "./rate-limit.js";
import { registerAttentionRoutes } from "./routes/attention.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerProfileRoutes, seedDefaultProfiles } from "./routes/profiles.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerViewRoutes } from "./routes/views.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { type Clock, Store } from "./store.js";
import { TerminalHub } from "./terminal-hub.js";
import { TerminalLogins } from "./terminal-login.js";

/** Minimum length of `SWITCHYARD_HOST_ENROLL_SECRET`. */
export const MIN_HOST_ENROLL_SECRET_LENGTH = 32;

export interface CreateCoordinatorOptions extends BuiltinOptions {
  dataDir: string;
  /** Public base URL. Defaults to `http://localhost:<port>` once listening. */
  publicUrl?: string;
  listen?: { host?: string; port?: number };
  /** Defaults to the origin of `publicUrl`. */
  trustedOrigins?: string[];
  webDist?: string | null;
  logger?: Logger;
  clock?: Clock;
  unreachableAfterMs?: number;
  foregroundLeaseMs?: number;
  commandTimeoutMs?: number;
  /** Shared host enrollment secret (at least 32 characters); enables `POST /api/hosts/enroll {secret}`. */
  hostEnrollSecret?: string;
  /**
   * Reverse proxies (IPs or CIDRs) whose `X-Forwarded-For` is trusted for the client IP. Default
   * none: the socket address is the client.
   */
  trustedProxies?: string[];
  /** Owner sign-in through an OIDC provider. Needs at least one owner criterion. */
  oidc?: OidcConfig;
  /**
   * Per-IP limits per minute on public auth routes (default auth 20, hosts 10). `false` disables
   * them (test harnesses that enroll many devices from one address).
   */
  rateLimits?: false | { auth?: number; hosts?: number };
  /**
   * Print "no device is signed in yet: run `switchyard pair`" to stderr when a server without
   * single sign-on has no device or passkey (default true; `switchyard up` prints the link
   * itself). It is always logged.
   */
  setupHint?: boolean;
  /** Registered at `start()` before listening: extra routes and services (tasks, scheduler...). */
  plugins?: CoordinatorPlugin[];
  /** Retention sweep interval (default hourly). */
  retentionIntervalMs?: number;
}

export type CoordinatorPlugin = (c: Coordinator) => void | Promise<void>;

export interface Coordinator {
  app: FastifyInstance;
  store: Store;
  hostHub: HostHub;
  clientHub: ClientHub;
  auth: Auth;
  owner: Owner;
  passkeys: Passkeys;
  /** Null unless OIDC is configured. */
  oidc: Oidc | null;
  attention: AttentionService;
  /** Typed in-process events (`session.settled`, `host.connected`, `task.changed`, ...). */
  events: EventHub;
  ctx: CoordinatorContext;
  config: CoordinatorConfig;
  /** Contents of `admin.token` (implicit local admin device). */
  adminToken: string;
  /** Bound port after `start()`. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` after `start()`. */
  readonly localUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Route patterns reachable without a device credential. `/ws/host` authenticates the host
 * credential in its `hello` handshake. Everything else (including `/adapter-frames/*`) needs a
 * device.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "/api/enroll",
  "/api/setup",
  "/api/auth/passkey/options",
  "/api/auth/passkey/verify",
  "/api/auth/oidc/begin",
  "/api/auth/oidc/callback",
  "/api/auth/oidc/claim",
  "/api/auth/terminal/start",
  "/api/auth/terminal/claim",
  "/api/hosts/enroll",
  "/api/hooks/:automationId",
  "/healthz",
  "/readyz",
  "/ws/host",
]);

/** Files `@fastify/static` registered from the web build (it marks them with `config.file`). */
function isStaticFileRoute(req: FastifyRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const config = req.routeOptions.config as { file?: unknown; rootPath?: unknown } | undefined;
  return typeof config?.file === "string" && typeof config.rootPath === "string";
}

function isApiLikePath(url: string): boolean {
  let path = url.split("?")[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  return path.startsWith("/api/") || path.startsWith("/ws/") || path.startsWith("/adapter-frames/");
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Refuse to start with an unsafe auth configuration. */
function validateAuthOptions(opts: CreateCoordinatorOptions): void {
  if (
    opts.hostEnrollSecret !== undefined &&
    opts.hostEnrollSecret.length < MIN_HOST_ENROLL_SECRET_LENGTH
  ) {
    throw new SwitchyardError(
      "invalid_request",
      `SWITCHYARD_HOST_ENROLL_SECRET must be at least ${MIN_HOST_ENROLL_SECRET_LENGTH} characters`,
    );
  }
  if (!opts.oidc && opts.publicUrl && !isLoopbackUrl(opts.publicUrl)) {
    throw new SwitchyardError(
      "invalid_request",
      `Single sign-on is required for ${opts.publicUrl}: set SWITCHYARD_OIDC_ISSUER, SWITCHYARD_OIDC_CLIENT_ID and an owner (SWITCHYARD_OIDC_OWNER_*), see docs/auth.md. Without single sign-on, Switchyard runs only at a localhost public URL.`,
    );
  }
  if (opts.oidc && !hasOwnerMatch(opts.oidc.owner)) {
    throw new SwitchyardError(
      "invalid_request",
      "OIDC needs an owner match: set SWITCHYARD_OIDC_OWNER_SUBJECT, SWITCHYARD_OIDC_OWNER_EMAIL or SWITCHYARD_OIDC_OWNER_GROUP",
    );
  }
}

/** Build a coordinator: opens and migrates the DB, wires hubs and routes. Call `start()` to listen. */
export function createCoordinator(opts: CreateCoordinatorOptions): Coordinator {
  validateAuthOptions(opts);
  const dataDir = resolve(opts.dataDir);
  mkdirSync(dataDir, { recursive: true });
  acquireLock(dataDir);
  const log = opts.logger ?? createLogger();
  let db: Db;
  try {
    db = openDb(dbPath(dataDir));
    migrate(db);
  } catch (err) {
    releaseLock(dataDir);
    throw err;
  }
  const listenHost = opts.listen?.host ?? "0.0.0.0";
  const listenPort = opts.listen?.port ?? DEFAULT_PORT;
  const publicUrl = (opts.publicUrl ?? `http://localhost:${listenPort}`).replace(/\/+$/, "");
  const config: CoordinatorConfig = {
    dataDir,
    publicUrl,
    trustedOrigins: opts.trustedOrigins ?? [originOf(publicUrl)],
    webDist: opts.webDist ? resolve(opts.webDist) : null,
    secureCookies: publicUrl.startsWith("https:"),
    unreachableAfterMs: opts.unreachableAfterMs ?? 60_000,
    foregroundLeaseMs: opts.foregroundLeaseMs ?? 45_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 30_000,
    hostEnrollSecret: opts.hostEnrollSecret ?? null,
    oidc: opts.oidc ?? null,
  };

  const hub = new EventHub();
  hub.onListenerError = (name, err) => log.error({ err, event: name }, "event listener failed");
  const store = new Store(db, hub, opts.clock);
  const owner = new Owner(store, config);
  const auth = new Auth(store, config, hub);
  const adminToken = auth.ensureAdminToken();
  const passkeys = new Passkeys(store, owner, config, auth);
  const oidc = config.oidc ? new Oidc(store, owner, config, auth) : null;
  const terminalLogins = new TerminalLogins(store, config, auth);
  const limits = opts.rateLimits === false ? null : (opts.rateLimits ?? {});
  const storeClock = () => store.now().getTime();
  const limiters = {
    auth: new RateLimiter(
      limits ? (limits.auth ?? AUTH_RATE_LIMIT) : Number.POSITIVE_INFINITY,
      60_000,
      storeClock,
    ),
    hosts: new RateLimiter(
      limits ? (limits.hosts ?? HOSTS_RATE_LIMIT) : Number.POSITIVE_INFINITY,
      60_000,
      storeClock,
    ),
  };
  seedDefaultProfiles({ store });
  const attention = new AttentionService(store, hub);
  const hostHub = new HostHub(store, hub, attention, log.child({ mod: "host-hub" }), {
    unreachableAfterMs: config.unreachableAfterMs,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const terminalHub = new TerminalHub(store, hostHub, log.child({ mod: "terminal-hub" }));
  hostHub.setTerminalSink(terminalHub);
  const clientHub = new ClientHub(store, hub, log.child({ mod: "client-hub" }), {
    foregroundLeaseMs: config.foregroundLeaseMs,
  });
  const ctx: CoordinatorContext = {
    config,
    store,
    hub,
    hostHub,
    clientHub,
    auth,
    attention,
    owner,
    passkeys,
    oidc,
    terminalLogins,
    limiters,
    log,
    services: new Map(),
  };

  const app = Fastify({
    loggerInstance: log,
    bodyLimit: 32 * 1024 * 1024,
    // Only listed proxies may set the client IP (rate limits key on it); never forwarded headers
    // for cookies or origins, which derive from publicUrl.
    trustProxy: opts.trustedProxies?.length ? opts.trustedProxies : false,
  }) as unknown as FastifyInstance;
  installErrorHandler(app);
  app.register(fastifyCookie);
  app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  // Deny by default, keyed on the route Fastify matched (after it decoded the path), never on
  // the raw URL: `/%61pi/sessions` routes to `/api/sessions` and must authenticate like it.
  app.addHook("onRequest", async (req) => {
    const pattern = req.routeOptions.url;
    if (pattern === undefined) {
      // No route matched: the not-found handler serves the SPA shell or a 404. API-like misses
      // still authenticate so probing unknown API paths reveals nothing.
      if (isApiLikePath(req.url)) auth.authenticateRequest(req);
      return;
    }
    if (PUBLIC_ROUTES.has(pattern)) return;
    if (isStaticFileRoute(req)) return;
    auth.authenticateRequest(req, { websocket: pattern.startsWith("/ws/") });
  });

  app.register(async (scope) => {
    scope.get("/ws/host", { websocket: true }, (socket) => hostHub.handleSocket(socket));
    scope.get("/ws/client", { websocket: true }, (socket, req) =>
      clientHub.handleSocket(socket, req.device!),
    );
    scope.get("/ws/terminal/:sessionId", { websocket: true }, (socket, req) => {
      const { sessionId } = req.params as { sessionId: string };
      const q = req.query as { cols?: string; rows?: string; passive?: string };
      const size = (v: string | undefined, min: number, max: number, dflt: number) => {
        const n = Number.parseInt(v ?? "", 10);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
      };
      terminalHub.handleSocket(
        socket,
        sessionId,
        size(q.cols, 10, 1000, 80),
        size(q.rows, 5, 500, 24),
        q.passive === "1",
      );
    });
  });

  registerOpsRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerHostRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerViewRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerInteractionRoutes(app, ctx);
  registerAttentionRoutes(app, ctx);
  const builtins = installBuiltins(app, ctx, opts);
  const staticReady = registerStaticRoutes(app, ctx);

  let retentionTimer: NodeJS.Timeout | null = null;
  let port = 0;
  let started = false;
  let stopped = false;

  const coordinator: Coordinator = {
    app,
    store,
    hostHub,
    clientHub,
    auth,
    owner,
    passkeys,
    oidc,
    attention,
    events: hub,
    ctx,
    config,
    adminToken,
    get port() {
      return port;
    },
    get localUrl() {
      return `http://127.0.0.1:${port}`;
    },
    async start() {
      if (started) return;
      started = true;
      await staticReady;
      await builtins.start();
      for (const plugin of opts.plugins ?? []) await plugin(coordinator);
      hostHub.start();
      clientHub.start();
      await app.listen({ host: listenHost, port: listenPort });
      port = (app.server.address() as AddressInfo).port;
      if (!opts.publicUrl) {
        config.publicUrl = `http://localhost:${port}`;
        config.trustedOrigins = opts.trustedOrigins ?? [
          config.publicUrl,
          `http://127.0.0.1:${port}`,
        ];
      }
      const sweep = () => {
        try {
          const r = store.runRetention();
          if (r.deleted > 0) log.info(r, "event retention sweep");
        } catch (err) {
          log.error({ err }, "retention sweep failed");
        }
      };
      sweep();
      retentionTimer = setInterval(sweep, opts.retentionIntervalMs ?? 3_600_000);
      retentionTimer.unref();
      if (!config.oidc && auth.activeDeviceCount() === 0 && passkeys.count() === 0) {
        log.info("no device signed in yet: run `switchyard pair` on this machine");
        if (opts.setupHint !== false) {
          process.stderr.write(
            "No device is signed in yet. Run `switchyard pair` on this machine for a single-use sign-in link.\n",
          );
        }
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retentionTimer) clearInterval(retentionTimer);
      // Stop scheduling/delivery and cancel waits before closing the evaluator. Closing host
      // requests here lets in-flight delivery drain without waiting for receipt timeouts.
      const builtinsStopped = builtins.stop();
      hostHub.stop();
      await builtinsStopped;
      clientHub.stop();
      await app.close();
      db.close();
      releaseLock(dataDir);
    },
  };
  return coordinator;
}
