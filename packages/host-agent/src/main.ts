import { detectPi, type PiDetection } from "@switchyard/pi-runtime";
import { PROTOCOL_VERSION, type Receipt } from "@switchyard/protocol";
import { AdapterCatalog } from "./adapters.js";
import { CommandRouter, type HostTestHooks } from "./commands.js";
import {
  defaultConfigPath,
  defaultStateDir,
  type HostConfig,
  hostPlatform,
  loadConfig,
  statePaths,
} from "./config.js";
import { type HostDb, openHostDb } from "./db/index.js";
import { Dispatcher } from "./dispatch.js";
import { CoordinatorLink } from "./link.js";
import { createLogger, type Logger } from "./logger.js";
import { SessionSupervisor } from "./supervisor.js";
import { WorkspaceService } from "./workspaces.js";

/** Host agent version reported in `hello`. */
export const AGENT_VERSION = "0.1.0";

export interface RunHostAgentOptions {
  /** host.json path (default `SWITCHYARD_HOST_CONFIG` or `~/.config/switchyard/host.json`). */
  configPath?: string;
  /** Use this config instead of reading host.json. */
  config?: HostConfig;
  /** State dir (default `SWITCHYARD_STATE_DIR` or the platform default). */
  stateDir?: string;
  /** Pi binary (default `SWITCHYARD_PI_BIN` or `pi`). */
  piBin?: string;
  /** Extra `-e` extensions for every Pi process (tests load the fixture extension). */
  extraExtensions?: string[];
  /** Extra environment for Pi, checks and setup (e.g. PI_CODING_AGENT_DIR). */
  env?: Record<string, string | undefined>;
  /** Owner adapter dir (default `~/.config/switchyard/adapters`). */
  ownerAdapterDir?: string;
  logger?: Logger;
  /** Install SIGTERM/SIGINT handlers that stop gracefully (default true). */
  handleSignals?: boolean;
  /** Reconnect backoff steps (tests use short ones). */
  backoffMs?: number[];
  pingIntervalMs?: number;
  testHooks?: HostTestHooks;
  /** Timeout per check command. */
  checkTimeoutMs?: number;
}

export interface HostAgentHandle {
  hostId: string;
  config: HostConfig;
  db: HostDb;
  link: CoordinatorLink;
  supervisor: SessionSupervisor;
  router: CommandRouter;
  dispatcher: Dispatcher;
  pi: PiDetection;
  /** Sessions marked interrupted because the previous agent died. */
  interruptedOnStart: string[];
  /** Number of Pi processes spawned by this agent. */
  readonly spawnedPiProcesses: number;
  /** Graceful shutdown: stop every Pi (runtime `stopped`), close the link and the DB. */
  stop(): Promise<void>;
}

/** Start the host agent: DB, Pi detection, adapters, supervisor, router and coordinator link. */
export async function runHostAgent(opts: RunHostAgentOptions = {}): Promise<HostAgentHandle> {
  const env = opts.env ?? {};
  const mergedEnv = { ...process.env, ...env };
  const log = opts.logger ?? createLogger();
  const config = opts.config ?? loadConfig(opts.configPath ?? defaultConfigPath(mergedEnv));
  const paths = statePaths(opts.stateDir ?? defaultStateDir(mergedEnv));
  const piBin = opts.piBin ?? mergedEnv.SWITCHYARD_PI_BIN ?? "pi";

  const db = openHostDb(paths.db);
  const pi = await detectPi(piBin, env);
  if (!pi.compatible) log.warn({ reason: pi.reason }, "Pi is not usable; sessions will be refused");
  else log.info({ version: pi.version }, "Pi detected");

  let link!: CoordinatorLink;
  let router!: CommandRouter;
  link = new CoordinatorLink({
    db,
    coordinatorUrl: config.coordinatorUrl,
    hostId: config.hostId,
    credential: config.credential,
    log,
    backoffMs: opts.backoffMs,
    pingIntervalMs: opts.pingIntervalMs,
    hello: () => ({
      name: config.name,
      agentVersion: AGENT_VERSION,
      piVersion: pi.version,
      piCompatible: pi.compatible,
      platform: hostPlatform(),
      capabilities: pi.capabilities,
      protocolVersion: PROTOCOL_VERSION,
    }),
    onCommand: (commandId, command) => {
      void router.handle(commandId, command);
    },
  });

  let supervisor!: SessionSupervisor;
  const catalog = new AdapterCatalog({
    env: mergedEnv,
    ownerDir: opts.ownerAdapterDir,
    onDiagnostic: (d) => {
      db.tx(() =>
        link.emit({
          type: "diagnostic",
          data: { ...d, at: new Date().toISOString() },
        }),
      );
    },
  });

  supervisor = new SessionSupervisor({
    db,
    link,
    hostId: config.hostId,
    catalog,
    log,
    piBin,
    env,
    extraExtensions: opts.extraExtensions,
    runtimeDir: paths.runtime,
    pi: () => ({ compatible: pi.compatible, reason: pi.reason }),
  });
  const workspaces = new WorkspaceService({
    db,
    link,
    log,
    env,
    hasActiveSession: (p) => supervisor.hasActiveSession(p),
  });
  const dispatcher = new Dispatcher({ db, supervisor, workspaces, log });
  router = new CommandRouter({
    db,
    supervisor,
    dispatcher,
    workspaces,
    log,
    env,
    testHooks: opts.testHooks,
    checkTimeoutMs: opts.checkTimeoutMs,
    sendReceipt: (r: Receipt) => {
      link.sendReceipt(r);
    },
  });

  // Previous agent died with its children: never resume or replay, just record it.
  const interruptedOnStart = supervisor.recoverAfterRestart();
  const failedDispatches = dispatcher.recoverAfterRestart();
  if (interruptedOnStart.length > 0 || failedDispatches > 0) {
    log.warn(
      { sessions: interruptedOnStart.length, dispatches: failedDispatches },
      "recovered after restart",
    );
  }
  router.pruneReceipts();

  try {
    await catalog.init();
  } catch (err) {
    log.warn({ err: (err as Error).message }, "adapter discovery failed; bundled adapters only");
  }
  supervisor.emitAdapters();
  link.start();

  let stopping: Promise<void> | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    log.info({ signal }, "stopping host agent");
    void handle.stop().finally(() => process.exit(0));
  };
  if (opts.handleSignals !== false) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  const handle: HostAgentHandle = {
    hostId: config.hostId,
    config,
    db,
    link,
    supervisor,
    router,
    dispatcher,
    pi,
    interruptedOnStart,
    get spawnedPiProcesses() {
      return supervisor.spawnedProcesses;
    },
    stop() {
      stopping ??= (async () => {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        await supervisor.stopAll();
        // Let the final session.updated events go out before closing the socket.
        await new Promise((r) => setTimeout(r, 50));
        await link.stop();
        db.close();
      })();
      return stopping;
    },
  };
  return handle;
}
