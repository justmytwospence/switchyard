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

/** The terminal this Pi runs in (`herdr:<session>@<machine>`), or null. */
export function clientId(env: Env, host: string = hostname()): string | null {
  if (env.HERDR_ENV !== "1") return null;
  const fromSocket = /\/sessions\/([^/]+)\/herdr\.sock$/.exec(env.HERDR_SOCKET_PATH ?? "")?.[1];
  const name = fromSocket || env.HERDR_SESSION?.trim() || "default";
  return `herdr:${name}@${host}`;
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
