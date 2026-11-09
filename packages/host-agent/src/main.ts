import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { piAgentDir } from "@switchyard/adapter-sdk";
import { detectPi, type PiDetection, terminalSupport } from "@switchyard/pi-runtime";
import { PROTOCOL_VERSION, type Receipt } from "@switchyard/protocol";
import { AdapterCatalog } from "./adapters.js";
import { AgentBroker } from "./agent-broker.js";
import { stopAllShells } from "./checks.js";
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
import { type HostDb, openHostDb, PRUNE_INTERVAL_MS, pruneHostDb } from "./db/index.js";
import { Dispatcher } from "./dispatch.js";
import { GitHubService } from "./github.js";
import { CoordinatorLink } from "./link.js";
import { createLogger, type Logger } from "./logger.js";
import { MessageDeliveryWorker } from "./message-delivery.js";
import { SessionSupervisor, supportsAgentBridge } from "./supervisor.js";
import { TerminalRelay } from "./terminal-relay.js";
import { UsagePoller } from "./usage.js";
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
   * Run sessions as interactive Pi in terminal holders. Default on: host.json
   * `terminalSessions`, then `SWITCHYARD_TERMINAL_SESSIONS` (`1`/`0`), then true.
   */
  terminalSessions?: boolean;
}

/** The coordinator refused this host's credential: unknown (`unauthorized`) or revoked (`forbidden`). */
export type HostRejection = { code: "unauthorized" | "forbidden"; message: string };

/** The error a host logs when the coordinator rejects its credential, with the re-enroll command. */
export function rejectionMessage(
  r: HostRejection,
  coordinatorUrl: string,
  configPath: string,
): string {
  const why =
    r.code === "forbidden"
      ? `This host was revoked on coordinator ${coordinatorUrl}`
      : `Coordinator ${coordinatorUrl} does not recognize this host's credential (${r.message})`;
  return `${why}. The host agent stopped connecting. Create a host token in Settings › Hosts › Add host, then run: switchyard host enroll --coordinator ${coordinatorUrl} --token <token> --config ${configPath}`;
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
  /** Sessions marked interrupted because the previous agent died while they were working. */
  interruptedOnStart: string[];
  /** Idle sessions the previous agent left behind, quietly marked stopped (resumable). */
  stoppedOnStart: string[];
  /** Number of Pi processes spawned by this agent. */
  readonly spawnedPiProcesses: number;
  /** Whether sessions run in terminal holders. */
  terminalSessions: boolean;
  /**
   * Resolves when the coordinator rejected this host's credential (unknown or revoked); the link
   * is stopped then and the agent idles. Never resolves otherwise.
   */
  rejected: Promise<HostRejection>;
  /**
   * Graceful shutdown: stop every RPC Pi (runtime `stopped`), detach from terminal sessions (or
   * stop them with `terminals: "stop"`), close the link and the DB.
   */
  stop(opts?: { terminals?: "detach" | "stop" }): Promise<void>;
}

/**
 * Whether sessions run in terminal holders: the option, then host.json, then
 * `SWITCHYARD_TERMINAL_SESSIONS` (`1` on, `0` off), else on.
 */
export function terminalSessionsWanted(
  opt: boolean | undefined,
  config: Pick<HostConfig, "terminalSessions">,
  env: Record<string, string | undefined>,
): boolean {
  const flag = env.SWITCHYARD_TERMINAL_SESSIONS;
  const fromEnv = flag === "1" ? true : flag === "0" ? false : undefined;
  return opt ?? config.terminalSessions ?? fromEnv ?? true;
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
  pruneHostDb(db);
  const pi = await detectPi(piBin, env);
  if (!pi.compatible) log.warn({ reason: pi.reason }, "Pi is not usable; sessions will be refused");
  else log.info({ version: pi.version }, "Pi detected");

  const agentSupport = pi.compatible && supportsAgentBridge(pi.version);
  const wantTerminal = terminalSessionsWanted(opts.terminalSessions, config, mergedEnv);
  const termSupport = wantTerminal ? terminalSupport() : null;
  const terminalEnabled = termSupport?.ok === true;
  if (termSupport && !termSupport.ok) {
    log.warn(
      { reason: termSupport.reason },
      "terminal sessions unavailable; sessions run headless (RPC)",
    );
  } else if (terminalEnabled) {
    log.info("terminal sessions enabled");
  }

  let link!: CoordinatorLink;
  let router!: CommandRouter;
  let relay!: TerminalRelay;
  const github = new GitHubService({
    env: mergedEnv,
    db,
    publish: (path, snapshot) =>
      link.emit({ type: "workspace.updated", data: { path, github: snapshot } }),
  });
  await github.probe();
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
      capabilities: pi.capabilities
        ? {
            ...pi.capabilities,
            terminal: terminalEnabled,
            treeNavigation: terminalEnabled,
            agentRequests: agentSupport,
            messageDelivery: agentSupport,
            policies: agentSupport,
          }
        : null,
      features: agentSupport ? ["agentRequests.v1", "policies.v1"] : [],
      protocolVersion: PROTOCOL_VERSION,
      github: github.github,
    }),
    onTerm: (streamId, msg) => relay.handle(streamId, msg),
    onCommand: (commandId, command) => {
      // A command still in flight when stop() closes the DB must not crash the process.
      router.handle(commandId, command).catch((err: unknown) => {
        log.warn({ commandId, err: (err as Error)?.message }, "command aborted");
      });
    },
  });

  const broker = new AgentBroker({
    link,
    onError: (err, sessionId) => log.warn({ sessionId, err }, "agent broker failed"),
  });
  let supervisor!: SessionSupervisor;
  const delivery = new MessageDeliveryWorker({
    db,
    getBridge: (id) => supervisor.deliveryBridge(id),
  });
  const wakeDelivery = (sessionId?: string) => {
    void delivery
      .reconcile(sessionId)
      .catch((err: unknown) =>
        log.warn({ sessionId, err }, "message delivery reconciliation failed"),
      );
  };
  link.events.on("welcome", () => wakeDelivery());
  const deliveryTimer = setInterval(() => {
    void delivery.tick().catch((err: unknown) => log.warn({ err }, "message delivery tick failed"));
  }, 1000);
  deliveryTimer.unref();
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
    pi: () => ({ compatible: pi.compatible, reason: pi.reason, version: pi.version }),
    terminalSessions: terminalEnabled,
    broker,
    onDeliveryWake: wakeDelivery,
    observeToolOutput: (path, result) => github.observeToolOutput(path, result),
  });
  relay = new TerminalRelay({
    supervisor,
    send: (streamId, msg) => {
      link.sendTerm(streamId, msg);
    },
    log,
  });
  link.events.on("disconnected", () => relay.closeAll());
  const usagePoller = new UsagePoller({
    deps: {
      authPath: join(piAgentDir(mergedEnv), "auth.json"),
      fetch,
      now: Date.now,
      readFile: (p) => readFile(p, "utf8"),
    },
    send: (u) => {
      link.sendUsage(u);
    },
    log,
  });
  link.events.on("welcome", () => {
    const u = usagePoller.latest();
    if (u) link.sendUsage(u);
  });
  usagePoller.start();
  let resolveRejected!: (r: HostRejection) => void;
  const rejected = new Promise<HostRejection>((r) => {
    resolveRejected = r;
  });
  let refusal: string | null = null;
  link.events.on("rejected", ({ code, message }) => {
    if (code === "unauthorized" || code === "forbidden") {
      void link.stop();
      log.error(
        { code, configPath },
        rejectionMessage({ code, message }, config.coordinatorUrl, configPath),
      );
      resolveRejected({ code, message });
      return;
    }
    // A protocol mismatch is not a credential problem: keep retrying, but say so only once.
    if (refusal === message) return;
    refusal = message;
    log.error(
      { code },
      `The coordinator refused this host: ${message}. Upgrade Switchyard on this host or on the coordinator so both speak the same protocol.`,
    );
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
    delivery,
    github,
    sendReceipt: (r: Receipt) => {
      link.sendReceipt(r);
    },
  });

  // Previous agent died with its children: never resume or replay, just record it.
  const recovered = supervisor.recoverAfterRestart();
  const interruptedOnStart = recovered.interrupted;
  const stoppedOnStart = recovered.stopped;
  const failedDispatches = dispatcher.recoverAfterRestart();
  const failedCommands = router.recoverPending();
  if (
    interruptedOnStart.length > 0 ||
    stoppedOnStart.length > 0 ||
    failedDispatches > 0 ||
    failedCommands > 0
  ) {
    log.warn(
      {
        sessions: interruptedOnStart.length,
        stopped: stoppedOnStart.length,
        dispatches: failedDispatches,
        commands: failedCommands,
      },
      "recovered after restart",
    );
  }
  router.pruneReceipts();
  const pruneTimer = setInterval(() => {
    try {
      const counts = pruneHostDb(db);
      const receipts = router.pruneReceipts();
      if (receipts > 0 || Object.values(counts).some((n) => n > 0)) {
        log.info({ ...counts, receipts }, "pruned host database");
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "host database prune failed");
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  try {
    await catalog.init();
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "adapter discovery failed; Pi package adapters are not loaded",
    );
  }
  // After discovery: a reattached session opens its adapters, and a dialog Pi asks again must be
  // claimed by them (a plan, a question form), not shown as the generic fallback.
  const reattach = await supervisor.reattachTerminals();
  interruptedOnStart.push(...reattach.lost);
  stoppedOnStart.push(...reattach.stopped);
  if (
    reattach.reattached.length > 0 ||
    reattach.lost.length > 0 ||
    reattach.stopped.length > 0 ||
    reattach.starting.length > 0
  ) {
    log.info(
      {
        reattached: reattach.reattached.length,
        lost: reattach.lost.length,
        stopped: reattach.stopped.length,
        starting: reattach.starting.length,
      },
      "terminal sessions after restart",
    );
  }

  const swept = await supervisor.sweepOrphanHolders().catch((err) => {
    log.warn({ err: (err as Error).message }, "terminal holder sweep failed");
    return null;
  });
  if (
    swept &&
    swept.killed.length + swept.removed.length + swept.unreachable.length + swept.filesDeleted > 0
  ) {
    log.info(
      {
        killed: swept.killed.length,
        removed: swept.removed.length,
        unreachable: swept.unreachable.length,
        files: swept.filesDeleted,
      },
      "orphaned terminal holders cleaned up",
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
    stoppedOnStart,
    terminalSessions: terminalEnabled,
    rejected,
    get spawnedPiProcesses() {
      return supervisor.spawnedProcesses;
    },
    stop(stopOpts = {}) {
      stopping ??= (async () => {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        relay.closeAll();
        usagePoller.stop();
        clearInterval(deliveryTimer);
        await delivery.stop();
        broker.close();
        await Promise.all([supervisor.stopAll(stopOpts), stopAllShells(), github.stop()]);
        // Let the final session.updated events go out before closing the socket.
        await new Promise((r) => setTimeout(r, 50));
        await link.stop();
        clearInterval(pruneTimer);
        db.close();
      })();
      return stopping;
    },
  };
  return handle;
}
