import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { CliError, type ConnectionFlags, resolveConnection } from "../config.js";
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
import { loadMirrorState, mirrorStateOf } from "../herdr/new-session.js";
import {
  herdrStateDir,
  launcherExists,
  sessionStateDir,
  stableLauncherPath,
  writeStableLauncher,
} from "../herdr/util.js";
import type { Env } from "../paths.js";

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

  if (flags.once) {
    const { client, state } = await loadMirrorState(ctx, flags);
    try {
      const daemon = new MirrorDaemon({
        call,
        subscribe: () => ({ close() {} }),
        api: client.api,
        state,
        onStateChange: () => () => {},
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
    const daemonEnvironment = daemonEnv(ctx, flags, launcherPath);
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
  log(`daemon started (pid ${process.pid}, herdr session ${herdrSessionName(env)})`);
  const { client } = await loadMirrorState(ctx, flags, 24 * 60 * 60_000);
  client.onLogout((reason) => {
    log(`signed out: ${reason}`);
    process.exit(1);
  });
  const daemon = new MirrorDaemon({
    call,
    subscribe: (types, onEvent, onEnd) => herdrSubscribe(types, onEvent, onEnd, socket),
    api: client.api,
    state: () => (client.store.getState().synced ? mirrorStateOf(client) : null),
    onStateChange: (fn) => client.store.subscribe(fn),
    stateDir: dir,
    launcherPath,
    log,
  });
  await daemon.start();
  await new Promise(() => {});
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
