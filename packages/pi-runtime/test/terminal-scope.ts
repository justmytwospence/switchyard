import { type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  makeTerminalScope,
  type TerminalScope,
  type TerminalScopeOptions,
} from "../../test-fixtures/src/terminal-scope.js";
import { socketDirs } from "../src/bridge/socket-paths.js";
import { holderScriptPath, type PiTerminalProcess } from "../src/terminal-process.js";

type StartOptions = {
  runtimeDir?: string;
  onHolderSpawn?: (child: ChildProcess, socketPath: string) => void;
};
type Start = (opts: StartOptions) => Promise<unknown>;
type TerminalClass = { start: (...args: never[]) => Promise<unknown> };
type StartedTerminal = Pick<PiTerminalProcess, "socketPath" | "pid" | "exited" | "detach">;
type OwnedRuntime = {
  scope: TerminalScope;
  remember: (started: unknown) => void;
  observe: (child: ChildProcess, path: string) => void;
};
type Registry = { original: Start; scopes: Map<string, OwnedRuntime> };
type HolderIdentity = { piPid: number; holderPid: number };
const registries = new WeakMap<TerminalClass, Registry>();

export interface RuntimeTerminalScopeOptions
  extends Pick<TerminalScopeOptions, "timeoutMs" | "runtimeSubpath"> {
  /** Protocol timeouts; defaults match the holder's shutdown timing. */
  termMs?: number;
  exitMs?: number;
  closeMs?: number;
}

function savedExit(path: string): boolean {
  try {
    const rec: unknown = JSON.parse(readFileSync(`${path}.exit.json`, "utf8"));
    return validExit(rec);
  } catch {
    return false;
  }
}

function validExit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.code === null || typeof rec.code === "number") &&
    (rec.signal === null || typeof rec.signal === "string")
  );
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function psField(pid: number, field: "ppid" | "command"): string {
  try {
    return execFileSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
  } catch (error) {
    const { status, stdout } = error as { status?: number; stdout?: string };
    if (status === 1 && stdout?.trim() === "") return ""; // PID exited during lookup.
    throw error;
  }
}

function holderParent(piPid: number): number | undefined {
  if (pidGone(piPid)) return;
  const holderPid = Number(psField(piPid, "ppid"));
  const expected = `${process.execPath} ${holderScriptPath()}`;
  if (validPid(holderPid) && holderPid > 1 && holderPid !== piPid) {
    if (psField(holderPid, "command") === expected) return holderPid;
  }
  if (pidGone(piPid)) return; // Never adopt an orphan's new parent or an unknown process.
  throw new Error(
    `Pi PID ${piPid}: parent PID ${holderPid} is not the expected holder (${expected})`,
  );
}

async function stopHolder(
  path: string,
  options: RuntimeTerminalScopeOptions,
  identity?: HolderIdentity,
  recordExit?: () => void,
): Promise<void> {
  const termMs = options.termMs ?? 3000;
  const exitMs = options.exitMs ?? 2000;
  const closeMs = options.closeMs ?? 3000;
  const socket = createConnection(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let piPid = identity?.piPid;
  let holderPid = identity?.holderPid;
  let exited = false;
  let status = false;
  let connected = false;
  let unreachable = false;
  let closed = false;
  let buffer = "";
  try {
    await new Promise<void>((resolveDone, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          const pids = `Pi PID ${piPid ?? "unknown"}, holder PID ${holderPid ?? "unknown"}`;
          reject(new Error(`${path}: ${message} (${pids})`));
        }
      };
      const deadline = (ms: number, message: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(message), ms);
      };
      const exitObserved = () => {
        if (exited) return;
        exited = true;
        recordExit?.();
        deadline(closeMs, "socket closure or Pi/holder process exit timeout");
      };
      const check = () => {
        if (settled) return;
        if (!exited && !unreachable && savedExit(path)) exitObserved();
        if (!(exited || unreachable) || !closed || existsSync(path)) return;
        try {
          if (
            (piPid === undefined || pidGone(piPid)) &&
            (holderPid === undefined || pidGone(holderPid))
          ) {
            settled = true;
            resolveDone();
          }
        } catch (error) {
          fail(`cannot verify Pi/holder process exit: ${String(error)}`);
        }
      };
      socket.on("connect", () => {
        connected = true;
        socket.write(`${JSON.stringify({ role: "control" })}\n`);
        if (!exited) deadline(exitMs, "holder status timeout");
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (
          !connected &&
          (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ENOTSOCK")
        ) {
          try {
            rmSync(path, { force: true });
            unreachable = true;
            deadline(closeMs, "Pi/holder process exit timeout after socket became unreachable");
          } catch (error) {
            fail(`cannot remove stale socket: ${String(error)}`);
          }
        } else fail(`socket error: ${error.message}`);
      });
      socket.on("close", () => {
        closed = true;
        check();
        if (!exited && !unreachable) fail("socket closed without child exit evidence");
      });
      socket.setEncoding("utf8");
      socket.on("data", (data: string) => {
        if (settled) return;
        buffer += data;
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let rec: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            rec = value as Record<string, unknown>;
          } catch {
            fail("malformed protocol record");
            return;
          }
          if (rec.type === "holder_status") {
            if (rec.piPid !== null && !validPid(rec.piPid)) {
              fail("invalid holder status");
              return;
            }
            if (rec.piPid !== null) {
              if (piPid !== undefined && piPid !== rec.piPid) {
                fail(`holder status changed Pi PID to ${rec.piPid}`);
                return;
              }
              piPid = rec.piPid;
              try {
                holderPid ??= holderParent(piPid);
              } catch (error) {
                fail(`cannot verify holder identity: ${String(error)}`);
                return;
              }
            }
            if (!status) {
              status = true;
              if (savedExit(path)) exitObserved();
              if (!exited) {
                try {
                  if (piPid !== undefined && pidGone(piPid)) {
                    deadline(exitMs, "child exit evidence timeout after Pi exited");
                  } else {
                    socket.write(`${JSON.stringify({ type: "holder_kill", signal: "SIGTERM" })}\n`);
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                      try {
                        if (piPid === undefined || !pidGone(piPid)) {
                          socket.write(
                            `${JSON.stringify({ type: "holder_kill", signal: "SIGKILL" })}\n`,
                          );
                        }
                        deadline(exitMs, "child exit timeout after SIGTERM");
                      } catch (error) {
                        fail(`cannot verify Pi process exit: ${String(error)}`);
                      }
                    }, termMs);
                  }
                } catch (error) {
                  fail(`cannot verify Pi process exit: ${String(error)}`);
                }
              }
            }
          } else if (rec.type === "holder_exit") {
            if (!status && !savedExit(path)) {
              fail("holder exit received without status");
              return;
            }
            if (!validExit(rec)) {
              fail("malformed holder exit");
              return;
            }
            exitObserved();
          }
          check();
        }
      });
      poll = setInterval(check, 25);
      deadline(exitMs, "connection timeout");
    });
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    socket.destroy();
  }
}

/** Track holder starts for exactly this runtime, including starts issued by asynchronous hosts. */
export function makeRuntimeTerminalScope<T extends TerminalClass>(
  terminalClass: T,
  options: RuntimeTerminalScopeOptions = {},
): TerminalScope {
  const started = new Map<string, StartedTerminal>();
  const verified = new Map<string, HolderIdentity>();
  const stops = new Map<string, Promise<void>>();
  const piExits = new Set<string>();
  const children = new Map<
    string,
    { path: string; done: Promise<Error | undefined>; exited: boolean; abnormal: boolean }
  >();
  const observe = (child: ChildProcess, socketPath: string) => {
    const path = resolve(socketPath);
    if (!isOwnedSocket(path)) return;
    const entry = {
      path,
      done: Promise.resolve<Error | undefined>(undefined),
      exited: false,
      abnormal: false,
    };
    entry.done = new Promise((resolveDone) => {
      child.once("exit", (code, signal) => {
        entry.exited = true;
        entry.abnormal = code !== 0 || signal !== null;
        resolveDone(
          !entry.abnormal
            ? undefined
            : new Error(`holder child exited abnormally (code ${code}, signal ${signal})`),
        );
      });
      child.once("error", (error) => {
        if (child.pid === undefined) entry.exited = true;
        resolveDone(child.pid === undefined ? undefined : error);
      });
    });
    children.set(`${path} (holder ${children.size + 1})`, entry);
  };
  const stopSocket = (path: string) => {
    let stop = stops.get(path);
    if (!stop) {
      stop = stopHolder(path, options, verified.get(path), () => piExits.add(path));
      stops.set(path, stop);
      void stop.catch(() => {
        if (stops.get(path) === stop) stops.delete(path);
      });
    }
    return stop;
  };
  const scope = makeTerminalScope({ ...options, socketDirs, stopSocket });
  const dirs = socketDirs(scope.runtimeDir);
  const isOwnedSocket = (path: string) =>
    dirs.includes(dirname(path)) && /^term-.*\.sock$/.test(basename(path));
  const remember = (value: unknown) => {
    if (!value || typeof value !== "object" || !("socketPath" in value) || !("pid" in value))
      return;
    if (typeof value.socketPath !== "string") return;
    const path = resolve(value.socketPath);
    if (isOwnedSocket(path)) {
      started.set(path, value as StartedTerminal);
    }
  };
  const onHolderStop = (stop: () => Promise<void>) =>
    scope.onStop(stop, { repeatOnLateLaunch: true });
  // An attached stop can unlink the socket before the final scan. Capture its identity from the
  // attached transport's holder_status before running the caller's stops, without taking control.
  onHolderStop(async () => {
    await forEachHolder(started, async (path, terminal) => {
      const deadline = Date.now() + (options.exitMs ?? 2000);
      while (
        terminal.pid === undefined &&
        !terminal.exited &&
        existsSync(path) &&
        Date.now() < deadline
      ) {
        await delay(25);
      }
      const piPid = terminal.pid;
      if (!validPid(piPid)) return;
      const holderPid = holderParent(piPid);
      if (holderPid !== undefined) verified.set(path, { piPid, holderPid });
    });
  });
  let registry = registries.get(terminalClass);
  if (!registry) {
    const original = terminalClass.start as Start;
    registry = { original, scopes: new Map() };
    const shared = registry;
    terminalClass.start = ((opts: StartOptions) => {
      const owned = opts.runtimeDir && shared.scopes.get(resolve(opts.runtimeDir));
      return owned
        ? owned.scope.launch(async () => {
            const result = await original.call(terminalClass, {
              ...opts,
              onHolderSpawn: (child, path) => {
                owned.observe(child, path);
                opts.onHolderSpawn?.(child, path);
              },
            });
            owned.remember(result);
            return result;
          })
        : original.call(terminalClass, opts);
    }) as T["start"];
    registries.set(terminalClass, registry);
  }
  registry.scopes.set(resolve(scope.runtimeDir), { scope, remember, observe });
  const shared = registry;
  const dispose = scope.dispose.bind(scope);
  let final: Promise<void> | undefined;
  scope.dispose = () => {
    if (!final) {
      // Release only transports started by this scope before taking their control sockets.
      onHolderStop(() =>
        forEachHolder(started, async (path, terminal) => {
          if (!terminal.exited && typeof terminal.detach === "function") terminal.detach();
          started.delete(path);
        }),
      );
      // Verify captured holders even when the attached stops have already removed their sockets.
      onHolderStop(() => forEachHolder(verified, stopSocket));
      onHolderStop(() =>
        forEachHolder(children, async (_label, child) => {
          if (!child.exited && existsSync(child.path)) await stopSocket(child.path);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const error = await Promise.race([
              child.done,
              new Promise<Error>((resolveTimeout) => {
                timer = setTimeout(
                  () => resolveTimeout(new Error("holder child exit timeout")),
                  options.closeMs ?? 3000,
                );
              }),
            ]);
            if (error && !(child.abnormal && (piExits.has(child.path) || savedExit(child.path)))) {
              throw error;
            }
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      final = dispose().finally(() => {
        shared.scopes.delete(resolve(scope.runtimeDir));
        if (!shared.scopes.size) {
          terminalClass.start = shared.original as T["start"];
          registries.delete(terminalClass);
        }
      });
    }
    return final;
  };
  return scope;
}

async function forEachHolder<T>(
  holders: Map<string, T>,
  action: (path: string, holder: T) => Promise<void>,
): Promise<void> {
  const entries = [...holders];
  const results = await Promise.allSettled(entries.map(([path, holder]) => action(path, holder)));
  const errors = results.flatMap((result, index) =>
    result.status === "rejected" ? [`${entries[index][0]}: ${String(result.reason)}`] : [],
  );
  if (errors.length) throw new Error(errors.join("; "));
}
