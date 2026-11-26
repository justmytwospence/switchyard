import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "./state-dir.js";

/*
 * Enrolment: an interactive Pi the user started themselves (not by Switchyard) offers itself to
 * the local host agent through a socket in the agent's runtime directory; see
 * docs/terminal-sessions.md#sessions-you-start-yourself.
 */

type Env = Record<string, string | undefined>;

/** The tmux session this process runs in (`TMUX`), or null. */
function tmuxSessionName(env: Env): string | null {
  if (!env.TMUX) return null;
  try {
    const pane = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
    const name = execFileSync("tmux", ["display-message", "-p", ...pane, "#S"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The terminal this Pi runs in, as Switchyard names terminals (`herdr:<session>@<machine>` or
 * `tmux:<session>@<machine>`), or null. herdr wins when both are set (herdr inside tmux).
 */
export function clientId(
  env: Env,
  host: string = hostname(),
  tmuxName: (env: Env) => string | null = tmuxSessionName,
): string | null {
  if (env.HERDR_ENV === "1") {
    const fromSocket = /\/sessions\/([^/]+)\/herdr\.sock$/.exec(env.HERDR_SOCKET_PATH ?? "")?.[1];
    const name = fromSocket || env.HERDR_SESSION?.trim() || "default";
    return `herdr:${name}@${host}`;
  }
  const tmux = tmuxName(env);
  return tmux ? `tmux:${tmux}@${host}` : null;
}

/** The pane this Pi runs in, in its terminal's ids (`w1:p2`, `%3`), or null. */
export function paneId(env: Env): string | null {
  if (env.HERDR_ENV === "1") return env.HERDR_PANE_ID?.trim() || null;
  return env.TMUX ? env.TMUX_PANE?.trim() || null : null;
}

/**
 * The runtime directory to enrol in, or null when this Pi must not enrol: Switchyard started it,
 * the user opted out (`SWITCHYARD_ENROLL=0`), it has no terminal, or no host agent runs here.
 */
export function enrollRuntimeDir(env: Env, tty: boolean): string | null {
  if (env.SWITCHYARD_CONTROL_SOCKET || env.SWITCHYARD_BRIDGE_SOCKET) return null;
  if (env.SWITCHYARD_ENROLL === "0" || !tty) return null;
  const stateDir = env.SWITCHYARD_ENROLL_STATE_DIR?.trim() || defaultStateDir(env);
  const dir = join(stateDir, "runtime");
  return existsSync(dir) ? dir : null;
}

/** What an enrolled Pi writes next to its socket for the host agent. */
export interface EnrollMeta {
  pid: number;
  cwd: string;
  client: string | null;
  /** The pane in `client` (absent from older extensions). */
  pane?: string | null;
  sessionId: string;
  sessionFile: string;
  startedAt: string;
}

export function metaPath(socketPath: string): string {
  return `${socketPath}.json`;
}

export function isEnrollMeta(v: unknown): v is EnrollMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.pid === "number" &&
    Number.isInteger(m.pid) &&
    m.pid > 0 &&
    typeof m.cwd === "string" &&
    m.cwd.startsWith("/") &&
    (m.client === null || typeof m.client === "string") &&
    (m.pane === undefined || m.pane === null || typeof m.pane === "string") &&
    typeof m.sessionId === "string" &&
    m.sessionId.length > 0 &&
    typeof m.sessionFile === "string" &&
    m.sessionFile.length > 0 &&
    typeof m.startedAt === "string"
  );
}

/** The meta file of an enrolment socket, or null when missing or invalid. */
export function readEnrollMeta(socketPath: string): EnrollMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath(socketPath), "utf8"));
    return isEnrollMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
