import { readFileSync } from "node:fs";
import { detectPi, type PiDetection, terminalSupport } from "@switchyard/pi-runtime";
import { PROTOCOL_VERSION, type Receipt } from "@switchyard/protocol";
import { AdapterCatalog } from "./adapters.js";
import { CommandRouter, type HostTestHooks } from "./commands.js";
import {
  defaultConfigPath,
  defaultStateDir,
  type HostConfig,
  hostPlatform,
  statePaths,
  type WaitTiming,
  waitForConfig,
} from "./config.js";
import { type HostDb, openHostDb } from "./db/index.js";
import { Dispatcher } from "./dispatch.js";
import { CoordinatorLink } from "./link.js";
import { createLogger, type Logger } from "./logger.js";
import { SessionSupervisor } from "./supervisor.js";
import { TerminalRelay } from "./terminal-relay.js";
import { WorkspaceService } from "./workspaces.js";

/** Host agent version reported in `hello` (this package's `package.json` version). */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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
  /** Aborts waiting for host.json (or self-enrollment) when the config is missing. */
  signal?: AbortSignal;
  /** Test overrides for the waits while the config is missing. */
  configWaitTiming?: Partial<WaitTiming>;
  /**
   * Run sessions as interactive Pi in terminal holders (default: host.json `terminalSessions`,
   * else `SWITCHYARD_TERMINAL_SESSIONS=1`).
   */
  terminalSessions?: boolean;
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
  /** Whether sessions run in terminal holders. */
  terminalSessions: boolean;
  /**
   * Graceful shutdown: stop every RPC Pi (runtime `stopped`), detach from terminal sessions (or
   * stop them with `terminals: "stop"`), close the link and the DB.
   */
  stop(opts?: { terminals?: "detach" | "stop" }): Promise<void>;
}

/** Start the host agent: DB, Pi detection, adapters, supervisor, router and coordinator link. */
export async function runHostAgent(opts: RunHostAgentOptions = {}): Promise<HostAgentHandle> {
  const env = opts.env ?? {};
  const mergedEnv = { ...process.env, ...env };
  const log = opts.logger ?? createLogger();
  const configPath = opts.configPath ?? defaultConfigPath(mergedEnv);
  // host.json when it exists; otherwise wait (self-enrolling with the shared secret when set).
  const config =
    opts.config ??
    (await waitForConfig({
      configPath,
      env: mergedEnv,
      log,
      signal: opts.signal,
      timing: opts.configWaitTiming,
    }));
  const paths = statePaths(opts.stateDir ?? defaultStateDir(mergedEnv));
  const piBin = opts.piBin ?? mergedEnv.SWITCHYARD_PI_BIN ?? "pi";

  const db = openHostDb(paths.db);
  const pi = await detectPi(piBin, env);
  if (!pi.compatible) log.warn({ reason: pi.reason }, "Pi is not usable; sessions will be refused");
  else log.info({ version: pi.version }, "Pi detected");

  const wantTerminal =
    opts.terminalSessions ??
    config.terminalSessions ??
    mergedEnv.SWITCHYARD_TERMINAL_SESSIONS === "1";
  const termSupport = wantTerminal ? terminalSupport() : null;
  const terminalEnabled = termSupport?.ok === true;
  if (termSupport && !termSupport.ok) {
    log.warn(
      { reason: termSupport.reason },
      "terminal sessions requested but unavailable; sessions use RPC",
    );
  } else if (terminalEnabled) {
    log.info("terminal sessions enabled");
  }

  let link!: CoordinatorLink;
  let router!: CommandRouter;
  let relay!: TerminalRelay;
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
      capabilities: pi.capabilities ? { ...pi.capabilities, terminal: terminalEnabled } : null,
      protocolVersion: PROTOCOL_VERSION,
    }),
    onTerm: (streamId, msg) => relay.handle(streamId, msg),
    onCommand: (commandId, command) => {
      // A command still in flight when stop() closes the DB must not crash the process.
      router.handle(commandId, command).catch((err: unknown) => {
        log.warn({ commandId, err: (err as Error)?.message }, "command aborted");
      });
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
    terminalSessions: terminalEnabled,
  });
  relay = new TerminalRelay({
    supervisor,
    send: (streamId, msg) => {
      link.sendTerm(streamId, msg);
    },
    log,
  });
  link.events.on("disconnected", () => relay.closeAll());
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
  const reattach = await supervisor.reattachTerminals();
  interruptedOnStart.push(...reattach.lost);
  if (reattach.reattached.length > 0 || reattach.lost.length > 0) {
    log.info(
      { reattached: reattach.reattached.length, lost: reattach.lost.length },
      "terminal sessions after restart",
    );
  }

  try {
    await catalog.init();
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "adapter discovery failed; Pi package adapters are not loaded",
    );
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
    terminalSessions: terminalEnabled,
    get spawnedPiProcesses() {
      return supervisor.spawnedProcesses;
    },
    stop(stopOpts = {}) {
      stopping ??= (async () => {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        relay.closeAll();
        await supervisor.stopAll(stopOpts);
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
