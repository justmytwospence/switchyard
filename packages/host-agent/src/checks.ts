import { spawn } from "node:child_process";
import type { CheckResult, ChecksResult } from "@switchyard/protocol";

export const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
export const OUTPUT_TAIL_BYTES = 8 * 1024;

/** Grace between SIGTERM and SIGKILL when a command times out. */
const KILL_GRACE_MS = 3000;
/** How long to wait for stdio to close after the shell exits (grandchildren may hold it open). */
const CLOSE_GRACE_MS = 1000;

/** Keep the last `maxBytes` bytes of `text`, cut at a UTF-8 character boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  if (text.length <= maxBytes / 4) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

export interface ShellOutcome {
  /** Exit code, or null when killed by a signal, timed out or failed to spawn. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Spawn error, if the shell could not be started. */
  error: Error | null;
}

/**
 * Run an owner-configured command line with `/bin/sh -c` in `cwd`, streaming interleaved
 * stdout and stderr to `onChunk`. On timeout the shell gets SIGTERM, then SIGKILL after 3 s.
 */
export function spawnShell(
  cwd: string,
  cmd: string,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; onChunk: (chunk: string) => void },
): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (outcome: ShellOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      resolve(outcome);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (!settled) opts.onChunk(chunk);
      });
    }

    child.on("error", (error) => {
      finish({ code: null, signal: null, timedOut, error });
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Stdio normally closes right after exit; a backgrounded grandchild may keep it open.
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: timedOut ? null : code, signal, timedOut, error: null });
      }, CLOSE_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      const c = exit?.code ?? code;
      const s = exit?.signal ?? signal;
      finish({ code: timedOut ? null : c, signal: s, timedOut, error: null });
    });
  });
}

/** Run each command in turn (all of them, regardless of failures) and collect exit codes and output tails. */
export async function runChecks(
  path: string,
  commands: string[],
  opts: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onOutput?: (command: string, chunk: string) => void;
  } = {},
): Promise<ChecksResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const results: CheckResult[] = [];
  for (const command of commands) {
    let tail = "";
    const outcome = await spawnShell(path, command, {
      timeoutMs,
      env: opts.env,
      onChunk: (chunk) => {
        tail = tailBytes(tail + chunk, OUTPUT_TAIL_BYTES);
        opts.onOutput?.(command, chunk);
      },
    });
    if (outcome.error) {
      results.push({ command, exitCode: null, outputTail: outcome.error.message });
      continue;
    }
    if (outcome.timedOut) tail += `\n[timed out after ${timeoutMs} ms]`;
    results.push({ command, exitCode: outcome.code, outputTail: tail });
  }
  return { results };
}
