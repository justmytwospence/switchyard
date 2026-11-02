import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { DEFAULT_PORT } from "@switchyard/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import QRCode from "qrcode";
import { AttentionService } from "./attention.js";
import { Auth } from "./auth.js";
import { type BuiltinOptions, installBuiltins } from "./builtins.js";
import { ClientHub } from "./client-hub.js";
import type { CoordinatorConfig, CoordinatorContext } from "./context.js";
import { type Db, migrate, openDb } from "./db/index.js";
import { EventHub } from "./event-hub.js";
import { HostHub } from "./host-hub.js";
import { installErrorHandler } from "./http.js";
import { createLogger } from "./logger.js";
import { acquireLock, dbPath, releaseLock } from "./ops.js";
import { registerAttentionRoutes } from "./routes/attention.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerProfileRoutes, seedDefaultProfile } from "./routes/profiles.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { type Clock, Store } from "./store.js";

export interface BootstrapInfo {
  url: string;
  token: string;
  expiresAt: string;
  qrTerminal: string;
}

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
  /** Called with the bootstrap enrollment when no devices exist; `false` disables. Default prints. */
  bootstrap?: false | ((info: BootstrapInfo) => void);
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

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Build a coordinator: opens and migrates the DB, wires hubs and routes. Call `start()` to listen. */
export function createCoordinator(opts: CreateCoordinatorOptions): Coordinator {
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
  };

  const hub = new EventHub();
  hub.onListenerError = (name, err) => log.error({ err, event: name }, "event listener failed");
  const store = new Store(db, hub, opts.clock);
  const auth = new Auth(store, config, hub);
  const adminToken = auth.ensureAdminToken();
  seedDefaultProfile({ store });
  const attention = new AttentionService(store, hub);
  const hostHub = new HostHub(store, hub, attention, log.child({ mod: "host-hub" }), {
    unreachableAfterMs: config.unreachableAfterMs,
    commandTimeoutMs: config.commandTimeoutMs,
  });
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
    log,
    services: new Map(),
  };

  const app = Fastify({
    loggerInstance: log,
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
  }) as unknown as FastifyInstance;
  installErrorHandler(app);
  app.register(fastifyCookie);
  app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? "";
    if (path === "/api/enroll" || path === "/api/hosts/enroll" || path.startsWith("/api/hooks/")) {
      return;
    }
    if (path.startsWith("/api/") || path.startsWith("/adapter-frames/")) {
      auth.authenticateRequest(req);
    } else if (path === "/ws/client") {
      auth.authenticateRequest(req, { websocket: true });
    }
  });

  app.register(async (scope) => {
    scope.get("/ws/host", { websocket: true }, (socket) => hostHub.handleSocket(socket));
    scope.get("/ws/client", { websocket: true }, (socket, req) =>
      clientHub.handleSocket(socket, req.device!),
    );
  });

  registerOpsRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerHostRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
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
      builtins.start();
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
      if (opts.bootstrap !== false && auth.activeDeviceCount() === 0) {
        const e = auth.createEnrollment("device", null);
        const qrTerminal = await QRCode.toString(e.url, { type: "terminal", small: true });
        const info: BootstrapInfo = {
          url: e.url,
          token: e.token,
          expiresAt: e.expiresAt,
          qrTerminal,
        };
        log.info(
          { url: e.url, expiresAt: e.expiresAt },
          "no devices enrolled: open the bootstrap URL",
        );
        if (opts.bootstrap) opts.bootstrap(info);
        else {
          process.stderr.write(
            `\nSwitchyard: enroll your first device (expires ${e.expiresAt}):\n${e.url}\n${qrTerminal}\nRun \`switchyard pair\` for a new link.\n\n`,
          );
        }
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retentionTimer) clearInterval(retentionTimer);
      builtins.stop();
      hostHub.stop();
      clientHub.stop();
      await app.close();
      db.close();
      releaseLock(dataDir);
    },
  };
  return coordinator;
}
