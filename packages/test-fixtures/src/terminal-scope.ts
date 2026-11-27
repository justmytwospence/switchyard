import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Fixture-owned terminal state. The runtime-specific protocol is supplied by the caller. */
export interface TerminalScopeOptions {
  /** All socket directories belonging to this runtime, including the long-path fallback. */
  socketDirs(runtimeDir: string): string[];
  /** Stop the holder and verify that its child exited and its socket closed. */
  stopSocket(socketPath: string): Promise<void>;
  timeoutMs?: number;
  /** Relative path under the private root, useful for exercising long socket paths. */
  runtimeSubpath?: string;
}

export interface TerminalScope {
  readonly root: string;
  readonly runtimeDir: string;
  /** Register starts before they can race teardown. */
  launch<T>(start: () => Promise<T>): Promise<T>;
  /** Register a shutdown step. Only repeatable holder cleanup should run after late launches. */
  onStop(stop: () => Promise<unknown>, options?: { repeatOnLateLaunch?: boolean }): void;
  dispose(): Promise<void>;
}

export function makeTerminalScope(options: TerminalScopeOptions): TerminalScope {
  const subpath = options.runtimeSubpath ?? "runtime";
  if (
    !subpath ||
    isAbsolute(subpath) ||
    subpath.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw new Error("runtimeSubpath must be a nonempty relative path within the scope");
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sy-terminal-scope-")));
  const runtimeDir = resolve(root, subpath);
  if (!relative(root, runtimeDir) || relative(root, runtimeDir).startsWith(`..${sep}`)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("runtimeSubpath must be within the scope");
  }
  const starts = new Set<Promise<unknown>>();
  const stops: { stop: () => Promise<unknown>; repeatOnLateLaunch?: boolean }[] = [];
  let disposal: Promise<void> | undefined;
  let launchBarrierTimedOut = false;
  let lateCleanup: Promise<void> | undefined;
  const timeoutMs = options.timeoutMs ?? 20000;
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`terminal scope timed out: ${label}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const clean = async (errors: unknown[], late = false): Promise<void> => {
    for (const { stop, repeatOnLateLaunch } of stops) {
      if (late && !repeatOnLateLaunch) continue;
      try {
        await bounded(Promise.resolve().then(stop), "attached session stop");
      } catch (error) {
        errors.push(error);
      }
    }
    const dirs = options.socketDirs(runtimeDir);
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
        continue;
      }
      for (const name of names.filter((n) => /^term-.*\.sock$/.test(n))) {
        const path = join(dir, name);
        try {
          await bounded(
            Promise.resolve().then(() => options.stopSocket(path)),
            `holder ${path}`,
          );
        } catch (error) {
          errors.push(error);
        }
      }
    }
    for (const dir of dirs) {
      try {
        for (const name of readdirSync(dir).filter((n) => /^term-.*\.sock$/.test(n))) {
          errors.push(new Error(`holder socket remains: ${join(dir, name)}`));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `terminal scope cleanup failed; retained ${root}: ${errors.map(String).join("; ")}`,
      );
    if (late) return; // Preserve the diagnostics from the failed disposal.
    // Only the fallback directory associated with this unique runtime belongs to this scope.
    for (const dir of dirs) if (dir !== runtimeDir) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    runtimeDir,
    launch<T>(start: () => Promise<T>): Promise<T> {
      if (disposal) throw new Error("terminal scope is disposing");
      const pending = Promise.resolve().then(start);
      starts.add(pending);
      const settled = () => {
        starts.delete(pending);
        if (!launchBarrierTimedOut || !disposal) return;
        // Recheck after the initial cleanup, even if another launch never settles. Don't race
        // socket stops or delay the caller's start result or the bounded disposal.
        lateCleanup = (lateCleanup ?? disposal.catch(() => {}))
          .then(() => clean([], true))
          .catch((error) => console.error("late terminal scope cleanup failed", error));
      };
      void pending.then(settled, settled);
      return pending;
    },
    onStop(stop, opts) {
      if (disposal) throw new Error("terminal scope is disposing");
      stops.push({ stop, repeatOnLateLaunch: opts?.repeatOnLateLaunch });
    },
    dispose() {
      if (disposal) return disposal;
      disposal = (async () => {
        const errors: unknown[] = [];
        try {
          await bounded(Promise.allSettled([...starts]), "pending launches");
        } catch (error) {
          launchBarrierTimedOut = true;
          errors.push(error);
        }
        await clean(errors);
      })();
      return disposal;
    },
  };
}
