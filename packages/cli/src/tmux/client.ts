import { execFile, spawn } from "node:child_process";
import type { Env } from "../paths.js";

export class TmuxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxUnavailable";
  }
}
export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

/** Run one tmux command, resolving with its stdout. */
export type TmuxRun = (args: string[]) => Promise<string>;

export const tmuxRun: TmuxRun = (args) =>
  new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new TmuxUnavailable("tmux is not installed"));
      }
      reject(new TmuxError(stderr.trim() || err.message));
    });
  });

/** The tmux session this process belongs to: the launcher's, else the current one, else "switchyard". */
export async function tmuxSessionName(env: Env = process.env, run: TmuxRun = tmuxRun) {
  if (env.SWITCHYARD_TMUX_SESSION) return env.SWITCHYARD_TMUX_SESSION;
  if (env.TMUX) {
    try {
      const name = (await run(["display-message", "-p", "#S"])).trim();
      if (name) return name;
    } catch {
      // fall through
    }
  }
  return "switchyard";
}

/** A session id (`$3`) targets as is; a name needs the exact-match `=` prefix. */
export function tmuxTarget(session: string): string {
  return session.startsWith("$") ? session : `=${session}`;
}

export type TmuxEvent =
  | { type: "window-close"; windowId: string }
  | { type: "window-add"; windowId: string }
  | { type: "window-renamed"; windowId: string; name: string };

/** Parse one control-mode notification line, or null for anything else. */
export function parseControlLine(line: string): TmuxEvent | null {
  let m = /^%(?:unlinked-)?window-close (@\d+)/.exec(line);
  if (m) return { type: "window-close", windowId: m[1]! };
  m = /^%window-add (@\d+)/.exec(line);
  if (m) return { type: "window-add", windowId: m[1]! };
  m = /^%window-renamed (@\d+) (.*)$/.exec(line);
  if (m) return { type: "window-renamed", windowId: m[1]!, name: m[2]! };
  return null;
}

export interface TmuxControl {
  close(): void;
}

/**
 * A read-only control-mode client of the session: it receives window notifications and sends
 * nothing (commands go through separate `tmux` invocations).
 */
export function tmuxControl(
  session: string,
  onEvent: (e: TmuxEvent) => void,
  onEnd: (reason: string) => void,
): TmuxControl {
  const child = spawn(
    "tmux",
    ["-C", "attach-session", "-t", tmuxTarget(session), "-f", "ignore-size,no-output,read-only"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  let closed = false;
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    onEnd(reason);
  };
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      const e = parseControlLine(line);
      if (e) onEvent(e);
    }
  });
  child.on("error", (err) => end(err.message));
  child.on("exit", () => end("closed"));
  return {
    close() {
      closed = true;
      child.stdin.end();
      child.kill();
    },
  };
}
