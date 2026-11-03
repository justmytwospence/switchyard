import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, Project, Session } from "@switchyard/protocol";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, table } from "../context.js";
import { type HerdrCall, herdrCall, herdrSocketPath } from "../herdr/client.js";
import { type HerdrPane, type HerdrWorkspace, planHerdr, sessionDir } from "../herdr/plan.js";
import type { Env } from "../paths.js";
import { tuiCommand } from "./tui.js";

/** `${XDG_STATE_HOME:-~/.local/state}/switchyard-herdr` */
export function herdrStateDir(env: Env = process.env, home = homedir()): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "switchyard-herdr");
}

function sessionsDir(env: Env): string {
  const dir = join(herdrStateDir(env), "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The command a session's pane runs: this CLI's `herdr pane <id>`. */
export function paneCommand(sessionId: string, env: Env = process.env): string {
  const cfg = env.SWITCHYARD_CLIENT_CONFIG?.trim();
  const prefix = cfg ? `SWITCHYARD_CLIENT_CONFIG=${shellQuote(cfg)} ` : "";
  const cli = process.argv[1] ?? "switchyard";
  return `${prefix}${shellQuote(process.execPath)} ${shellQuote(cli)} herdr pane ${shellQuote(sessionId)}`;
}

function parkedSessions(dir: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const id of readdirSync(dir)) if (existsSync(join(dir, id, "parked"))) out.add(id);
  } catch {
    // none yet
  }
  return out;
}

async function isAtShell(call: HerdrCall, paneId: string): Promise<boolean> {
  const info = (await call("pane.process_info", { pane_id: paneId }))?.process_info ?? {};
  const procs: { pid?: number }[] = info.foreground_processes ?? [];
  return procs.length === 0 || procs.every((p) => p.pid === info.shell_pid);
}

async function runInPane(call: HerdrCall, paneId: string, command: string): Promise<void> {
  await call("pane.send_text", { pane_id: paneId, text: command });
  await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
}

export interface TickDeps {
  call: HerdrCall;
  goneTicks: Map<string, number>;
}

/** One comparison of Switchyard and herdr; returns what it did. */
export async function herdrTick(
  ctx: Ctx,
  flags: ConnectionFlags,
  deps: TickDeps,
): Promise<string[]> {
  const { api } = connect(ctx, flags);
  const [sessions, hosts, projects] = await Promise.all([
    api.get<Session[]>("/api/sessions"),
    api.get<Host[]>("/api/hosts"),
    api.get<Project[]>("/api/projects"),
  ]);
  const panes: HerdrPane[] = (await deps.call("pane.list", {}))?.panes ?? [];
  const workspaces: HerdrWorkspace[] = (await deps.call("workspace.list", {}))?.workspaces ?? [];
  const dir = sessionsDir(ctx.env);
  const plan = planHerdr({
    sessions,
    hosts,
    projects,
    panes,
    workspaces,
    sessionsDir: dir,
    parked: parkedSessions(dir),
    goneTicks: deps.goneTicks,
  });
  const done: string[] = [];
  for (const c of plan.create) {
    const cwd = sessionDir(dir, c.sessionId);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const r = await deps.call("workspace.create", { cwd, label: c.label, focus: false });
    const paneId = r?.root_pane?.pane_id;
    if (paneId) await runInPane(deps.call, paneId, paneCommand(c.sessionId, ctx.env));
    done.push(`opened ${c.label} (${c.sessionId})`);
  }
  for (const r of plan.restartCandidates) {
    if (await isAtShell(deps.call, r.paneId)) {
      await runInPane(deps.call, r.paneId, paneCommand(r.sessionId, ctx.env));
      done.push(`reattached ${r.sessionId} in ${r.paneId}`);
    }
  }
  for (const r of plan.rename) {
    await deps.call("workspace.rename", { workspace_id: r.workspaceId, label: r.label });
    done.push(`renamed ${r.workspaceId} to ${r.label}`);
  }
  for (const ws of plan.close) {
    await deps.call("workspace.close", { workspace_id: ws });
    done.push(`closed ${ws}`);
  }
  for (const r of plan.report) {
    await deps
      .call("pane.report_agent", {
        pane_id: r.paneId,
        source: "switchyard",
        agent: "pi",
        state: r.state,
        message: r.message,
        custom_status: r.customStatus,
      })
      .catch(() => {});
  }
  return done;
}

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

/** `switchyard herdr daemon`: keep one herdr space per live terminal session. */
export async function herdrDaemon(ctx: Ctx, flags: DaemonFlags): Promise<void> {
  const state = herdrStateDir(ctx.env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pidFile = join(state, "daemon.pid");
  const logFile = join(state, "daemon.log");
  const call: HerdrCall = (method, params) => herdrCall(method, params, herdrSocketPath(ctx.env));
  if (flags.once) {
    const done = await herdrTick(ctx, flags, { call, goneTicks: new Map() });
    for (const l of done) ctx.out(l);
    if (done.length === 0) ctx.out("Nothing to change");
    return;
  }
  const running = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  if (flags.ensure) {
    if (running && pidAlive(running)) return;
    const fd = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(process.execPath, [process.argv[1]!, "herdr", "daemon"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
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
  log(`daemon started (pid ${process.pid}, herdr ${herdrSocketPath(ctx.env)})`);
  const delay = Number(ctx.env.SWITCHYARD_HERDR_START_DELAY ?? "8");
  await new Promise((r) => setTimeout(r, Math.max(0, delay) * 1000));
  const goneTicks = new Map<string, number>();
  let failing = "";
  for (;;) {
    try {
      for (const line of await herdrTick(ctx, flags, { call, goneTicks })) log(line);
      if (failing) log("recovered");
      failing = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== failing) log(`tick failed: ${msg}`);
      failing = msg;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Read one key in raw mode. */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.once("data", (d: Buffer) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(d.toString("utf8"));
    });
  });
}

/** `switchyard herdr pane <id>`: a herdr pane's loop around `switchyard tui`. */
export async function herdrPane(ctx: Ctx, sessionId: string, flags: ConnectionFlags) {
  const dir = sessionDir(sessionsDir(ctx.env), sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const parked = join(dir, "parked");
  for (;;) {
    rmSync(parked, { force: true });
    try {
      await tuiCommand(ctx, sessionId, flags);
    } catch (err) {
      ctx.err(err instanceof Error ? err.message : String(err));
    }
    ctx.err(`Detached from ${sessionId}. Enter: reattach   q: leave this pane as a shell`);
    for (;;) {
      const key = await readKey();
      if (key === "q" || key === "Q" || key === "\u0003") {
        writeFileSync(parked, "");
        return;
      }
      if (key === "\r" || key === "\n") break;
    }
  }
}

/** `switchyard herdr status`: which pane shows which session. */
export async function herdrStatus(ctx: Ctx, flags: ConnectionFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const sessions = await api.get<Session[]>("/api/sessions");
  let panes: HerdrPane[];
  try {
    panes = (await herdrCall("pane.list", {}, herdrSocketPath(ctx.env)))?.panes ?? [];
  } catch (err) {
    throw new CliError(`herdr is not reachable: ${(err as Error).message}`);
  }
  const dir = sessionsDir(ctx.env);
  const rows: string[][] = [];
  for (const p of panes) {
    const cwd = p.cwd ?? "";
    if (!cwd.startsWith(`${dir}/`)) continue;
    const id = cwd.slice(dir.length + 1);
    const s = sessions.find((x) => x.id === id);
    rows.push([id, p.pane_id, p.workspace_id, s?.runtime ?? "-"]);
  }
  if (rows.length === 0) {
    ctx.out("No session spaces");
    return;
  }
  for (const l of table(["SESSION", "PANE", "WORKSPACE", "RUNTIME"], rows)) ctx.out(l);
}
