import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Session, View } from "@switchyard/protocol";
import { CliError, type ConnectionFlags, localHostId, resolveConnection } from "../config.js";
import { type Ctx, connect, table } from "../context.js";
import {
  type HerdrCall,
  herdrCall,
  herdrSessionName,
  herdrSocketPath,
  herdrSubscribe,
} from "../herdr/client.js";
import { MirrorDaemon } from "../herdr/daemon.js";
import { claimedSession } from "../herdr/mirror.js";
import {
  herdrStateDir,
  launcherExists,
  sessionStateDir,
  stableLauncherPath,
  writeStableLauncher,
} from "../herdr/util.js";
import { pickerBinding, syncTerminal, terminalId } from "../mirror/binding.js";
import { loadMirrorState, mirrorStateOf } from "../mirror/state.js";
import type { Env } from "../paths.js";
import { bindingFromFlags, mirrorText, recordBinding } from "./terminals.js";

export { herdrNew } from "../herdr/new-session.js";
export { herdrPane } from "../herdr/pane.js";
export { herdrStateDir } from "../herdr/util.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonFlags extends ConnectionFlags {
  ensure?: boolean;
  once?: boolean;
}

/**
 * Environment for the background daemon: the caller's env plus the resolved connection.
 * The credential travels in the environment, never in argv (argv is visible to every user).
 */
export function daemonEnv(ctx: Ctx, flags: ConnectionFlags, launcherPath: string): Env {
  const conn = resolveConnection(flags, ctx.env, ctx.paths);
  return {
    ...ctx.env,
    SWITCHYARD_HERDR_LAUNCHER: launcherPath,
    SWITCHYARD_URL: conn.url,
    SWITCHYARD_TOKEN: conn.credential,
  };
}

/** `switchyard herdr daemon`: mirror Switchyard into this (paired) herdr session. */
export async function herdrDaemon(ctx: Ctx, flags: DaemonFlags): Promise<void> {
  const env = ctx.env;
  if (env.SWITCHYARD_HERDR_ROOT) {
    writeStableLauncher(herdrStateDir(env), env.SWITCHYARD_HERDR_ROOT);
  } else if (!launcherExists(env)) {
    throw new CliError("Run this through the herdr plugin once, so it can write its launcher");
  }
  const launcherPath = stableLauncherPath(env);
  const dir = sessionStateDir(env);
  const pidFile = join(dir, "daemon.pid");
  const logFile = join(dir, "daemon.log");
  const socket = herdrSocketPath(env);
  const call: HerdrCall = (method, params) => herdrCall(method, params, socket);
  const name = herdrSessionName(env);
  const machine = hostname();
  const id = terminalId("herdr", name, machine);

  if (flags.once) {
    const { client, state } = await loadMirrorState(ctx, flags);
    try {
      const daemon = new MirrorDaemon({
        call,
        subscribe: () => ({ close() {} }),
        api: client.api,
        state,
        onStateChange: () => () => {},
        view: () => pickerBinding(state(), env, id),
        stateDir: dir,
        launcherPath,
        log: () => {},
        intervalMs: 0,
      });
      const done = await daemon.reconcile();
      for (const l of done) ctx.out(l);
      if (done.length === 0) ctx.out("Nothing to change");
    } finally {
      client.close();
    }
    return;
  }

  const running = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  if (flags.ensure) {
    if (running && pidAlive(running)) return;
    let daemonEnvironment: Env;
    try {
      daemonEnvironment = daemonEnv(ctx, flags, launcherPath);
    } catch {
      return; // not signed in: stay quiet in every herdr session
    }
    const fd = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(process.execPath, [process.argv[1]!, "herdr", "daemon"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: daemonEnvironment,
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    return;
  }
  if (running && running !== process.pid && pidAlive(running)) return;
  writeFileSync(pidFile, String(process.pid));
  const log = (line: string) => ctx.out(`${new Date().toISOString()} ${line}`);
  log(`daemon started (pid ${process.pid}, herdr session ${name})`);
  const { client } = await loadMirrorState(ctx, flags, 24 * 60 * 60_000);
  client.onLogout((reason) => {
    log(`signed out: ${reason}`);
    process.exit(1);
  });
  let shows: string[] | undefined;
  const terminal = syncTerminal({
    api: client.api,
    info: {
      id,
      kind: "herdr",
      name,
      machine,
      hostId: localHostId(env, client.api.baseUrl),
    },
    state: () => (client.store.getState().synced ? mirrorStateOf(client) : null),
    subscribe: (fn) => client.store.subscribe(fn),
    env,
    shows: () => shows,
    wasMirroring: ownsSpaces(dir),
    log,
  });
  const daemon = new MirrorDaemon({
    call,
    subscribe: (types, onEvent, onEnd) => herdrSubscribe(types, onEvent, onEnd, socket),
    api: client.api,
    state: () => (client.store.getState().synced ? mirrorStateOf(client) : null),
    onStateChange: (fn) => client.store.subscribe(fn),
    view: () => terminal.binding(),
    terminalId: id,
    onShows: (ids) => {
      shows = ids;
      terminal.report();
    },
    stateDir: dir,
    launcherPath,
    log,
  });
  await daemon.start();
  const leave = () => void terminal.stop().finally(() => process.exit(0));
  process.once("SIGTERM", leave);
  process.once("SIGINT", leave);
  await new Promise(() => {});
}

/** Whether the mirror in this state directory created spaces (it was mirroring a view). */
export function ownsSpaces(dir: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "spaces.json"), "utf8"));
    return Object.keys(raw.spaces ?? {}).length > 0;
  } catch {
    return false;
  }
}

export interface PairFlags extends ConnectionFlags {
  session?: string;
  view?: string;
  all?: boolean;
  none?: boolean;
  cli?: string;
  clientConfig?: string;
  force?: boolean;
}

/**
 * Write `<config>/switchyard-<kind>/<session>.env`: how this multiplexer session runs switchyard
 * and which client.json it signs in with. What it mirrors is recorded with the coordinator.
 */
export function writePairFile(
  ctx: Ctx,
  kind: "herdr" | "tmux",
  session: string,
  flags: PairFlags,
): string {
  const base = ctx.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const path = join(base, `switchyard-${kind}`, `${session}.env`);
  if (existsSync(path) && !flags.force) {
    throw new CliError(`${path} exists; pass --force to replace it`);
  }
  const q = (v: string) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const lines = [
    flags.cli ? `SWITCHYARD_CLI=${q(flags.cli)}` : null,
    flags.clientConfig ? `SWITCHYARD_CLIENT_CONFIG=${q(flags.clientConfig)}` : null,
  ].filter(Boolean);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`, { mode: 0o600 });
  return path;
}

/**
 * Record what a paired session mirrors when `--view`, `--all` or `--none` is given, signed in
 * with the client.json the pairing names.
 */
export async function pairBinding(
  ctx: Ctx,
  kind: "herdr" | "tmux",
  session: string,
  flags: PairFlags,
): Promise<void> {
  if (flags.view === undefined && !flags.all && !flags.none) {
    ctx.out(
      `It mirrors nothing until you choose: switchyard terminals bind ${kind}:${session} --all (or --view <name>)`,
    );
    return;
  }
  const c: Ctx = flags.clientConfig
    ? { ...ctx, paths: { ...ctx.paths, clientConfig: flags.clientConfig } }
    : ctx;
  const { api } = connect(c, flags);
  const binding = await bindingFromFlags(api, flags);
  const t = await recordBinding(api, terminalId(kind, session, hostname()), binding);
  const views = await api.get<View[]>("/api/views");
  ctx.out(`${t.id} mirrors ${mirrorText(t, views)}`);
}

/** `switchyard herdr pair`: pair a herdr session (default: the unnamed one) with Switchyard. */
export async function herdrPair(ctx: Ctx, flags: PairFlags): Promise<void> {
  const session = flags.session ?? "default";
  const path = writePairFile(ctx, "herdr", session, flags);
  ctx.out(`Wrote ${path}`);
  await pairBinding(ctx, "herdr", session, flags);
  ctx.out(`Start it with: ${session === "default" ? "herdr" : `herdr --session ${session}`}`);
}

/** `switchyard herdr status`: which tab shows which session. */
export async function herdrStatus(ctx: Ctx, flags: ConnectionFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const sessions = await api.get<Session[]>("/api/sessions");
  let snap: any;
  try {
    snap = (await herdrCall("session.snapshot", {}, herdrSocketPath(ctx.env)))?.snapshot ?? {};
  } catch (err) {
    throw new CliError(`herdr is not reachable: ${(err as Error).message}`);
  }
  const labelOf = (id: string) =>
    (snap.workspaces ?? []).find((w: any) => w.workspace_id === id)?.label ?? id;
  const rows: string[][] = [];
  for (const p of snap.panes ?? []) {
    const id = claimedSession(p);
    if (!id) continue;
    const s = sessions.find((x) => x.id === id);
    rows.push([id, p.tab_id, labelOf(p.workspace_id), s?.runtime ?? "-"]);
  }
  if (rows.length === 0) {
    ctx.out("No session tabs");
    return;
  }
  for (const l of table(["SESSION", "TAB", "SPACE", "RUNTIME"], rows)) ctx.out(l);
}
