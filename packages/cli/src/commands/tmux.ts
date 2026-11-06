import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, table } from "../context.js";
import { bindingRef, trackPresence, viewOrMissing } from "../mirror/binding.js";
import { loadMirrorState, mirrorStateOf } from "../mirror/state.js";
import { tmuxControl, tmuxRun, tmuxSessionName, tmuxTarget } from "../tmux/client.js";
import { TmuxDaemon } from "../tmux/daemon.js";
import { WINDOW_OPTION } from "../tmux/mirror.js";
import {
  stableTmuxLauncherPath,
  tmuxLauncherExists,
  tmuxSessionStateDir,
  tmuxStateDir,
  writeStableTmuxLauncher,
} from "../tmux/util.js";
import { daemonEnv, type PairFlags, writePairFile } from "./herdr.js";

export { tmuxNew } from "../tmux/new-session.js";
export { tmuxPane } from "../tmux/pane.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface TmuxDaemonFlags extends ConnectionFlags {
  ensure?: boolean;
  once?: boolean;
}

/** `switchyard tmux daemon`: mirror Switchyard into this (paired) tmux session. */
export async function tmuxDaemon(ctx: Ctx, flags: TmuxDaemonFlags): Promise<void> {
  const env = ctx.env;
  if (env.SWITCHYARD_TMUX_ROOT) {
    writeStableTmuxLauncher(tmuxStateDir(env), env.SWITCHYARD_TMUX_ROOT);
  } else if (!tmuxLauncherExists(env)) {
    throw new CliError("Run this through the tmux launcher once, so it can write its launcher");
  }
  const launcherPath = stableTmuxLauncherPath(env);
  const name0 = await tmuxSessionName(env);
  // Target the session by id so renaming it rebinds the view instead of losing the session.
  let session = name0;
  try {
    const id = (
      await tmuxRun(["display-message", "-p", "-t", tmuxTarget(name0), "#{session_id}"])
    ).trim();
    if (id) session = id;
  } catch {
    // not running yet: fall back to the name
  }
  const sessionName = async () =>
    (await tmuxRun(["display-message", "-p", "-t", tmuxTarget(session), "#S"])).trim() || name0;
  const dir = tmuxSessionStateDir(name0, env);
  const pidFile = join(dir, "daemon.pid");
  const logFile = join(dir, "daemon.log");
  const viewOf = (st: ReturnType<typeof mirrorStateOf>, name: string) =>
    viewOrMissing(st, bindingRef(env, name));

  if (flags.once) {
    const { client, state } = await loadMirrorState(ctx, flags);
    try {
      const daemon = new TmuxDaemon({
        run: tmuxRun,
        control: () => ({ close() {} }),
        api: client.api,
        session,
        state,
        onStateChange: () => () => {},
        view: (n) => viewOf(state(), n),
        sessionName,
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
    let environment: Record<string, string | undefined>;
    try {
      environment = {
        ...daemonEnv(ctx, flags, launcherPath),
        SWITCHYARD_TMUX_LAUNCHER: launcherPath,
        SWITCHYARD_TMUX_SESSION: name0,
      };
    } catch {
      return; // not signed in: stay quiet in every tmux session
    }
    const fd = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(process.execPath, [process.argv[1]!, "tmux", "daemon"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: environment,
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
  log(`daemon started (pid ${process.pid}, tmux session ${name0})`);
  const { client } = await loadMirrorState(ctx, flags, 24 * 60 * 60_000);
  client.onLogout((reason) => {
    log(`signed out: ${reason}`);
    process.exit(1);
  });
  let currentName = name0;
  const trackedName = async () => (currentName = await sessionName());
  const daemon = new TmuxDaemon({
    run: tmuxRun,
    control: tmuxControl,
    api: client.api,
    session,
    state: () => (client.store.getState().synced ? mirrorStateOf(client) : null),
    onStateChange: (fn) => client.store.subscribe(fn),
    view: (n) => viewOf(mirrorStateOf(client), n),
    sessionName: trackedName,
    stateDir: dir,
    launcherPath,
    log,
  });
  await daemon.start();
  const machine = hostname();
  const presence = trackPresence({
    api: client.api,
    getView: () => {
      const v = viewOf(mirrorStateOf(client), currentName);
      return v === "missing" ? null : v;
    },
    subscribe: (fn) => client.store.subscribe(fn),
    client: { id: `tmux:${name0}@${machine}`, kind: "tmux", name: name0, machine },
    log,
  });
  const leave = () => void presence.stop().finally(() => process.exit(0));
  process.once("SIGTERM", leave);
  process.once("SIGINT", leave);
  await new Promise(() => {});
}

/** `switchyard tmux status`: which window shows which session. */
export async function tmuxStatus(ctx: Ctx, flags: ConnectionFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const sessions = await api.get<Session[]>("/api/sessions");
  const name = await tmuxSessionName(ctx.env);
  let out: string;
  try {
    out = await tmuxRun([
      "list-windows",
      "-t",
      `=${name}`,
      "-F",
      `#{window_id}\t#{window_name}\t#{${WINDOW_OPTION}}`,
    ]);
  } catch (err) {
    throw new CliError(`tmux session ${name} is not reachable: ${(err as Error).message}`);
  }
  const rows: string[][] = [];
  for (const line of out.split("\n")) {
    const [wid, wname, sid] = line.split("\t");
    if (!sid) continue;
    rows.push([sid, wid ?? "", wname ?? "", sessions.find((s) => s.id === sid)?.runtime ?? "-"]);
  }
  if (rows.length === 0) {
    ctx.out("No session windows");
    return;
  }
  for (const l of table(["SESSION", "WINDOW", "NAME", "RUNTIME"], rows)) ctx.out(l);
}

/** `switchyard tmux pair`: pair a tmux session (default: switchyard) with Switchyard. */
export async function tmuxPair(ctx: Ctx, flags: PairFlags): Promise<void> {
  const session = flags.session ?? "switchyard";
  const path = writePairFile(ctx, "tmux", session, flags);
  ctx.out(`Wrote ${path}`);
  ctx.out("Load the plugin in .tmux.conf: run-shell <repo>/integrations/tmux/switchyard.tmux");
  ctx.out(`Then start it with: tmux new-session -s ${session}`);
}
