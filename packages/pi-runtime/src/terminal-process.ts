import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlReader, writeJsonl } from "./jsonl.js";
import {
  type PiExit,
  PiRpcError,
  START_CANCELED,
  screenTail,
  shortSocketPath,
} from "./rpc-process.js";
import type { PiTransport } from "./transport.js";
import type { BridgeEvent, PiUiRequest, PiUiResponseBody } from "./types.js";

function resolveDist(rel: string): string {
  const sibling = fileURLToPath(new URL(`./${rel}`, import.meta.url));
  if (existsSync(sibling)) return sibling;
  // Running from src/ (tests): use the compiled copy.
  return fileURLToPath(new URL(`../dist/${rel}`, import.meta.url));
}

/** Absolute path of the compiled terminal holder script. */
export function holderScriptPath(): string {
  return resolveDist("terminal/holder.js");
}

/** Absolute path of the compiled Switchyard terminal extension loaded into interactive Pi. */
export function terminalExtensionPath(): string {
  return resolveDist("bridge/switchyard-terminal.js");
}

/** Whether this machine can run terminal sessions (node-pty loads, the holder is built). */
export function terminalSupport(): { ok: true } | { ok: false; reason: string } {
  try {
    createRequire(import.meta.url)("node-pty");
  } catch (err) {
    return { ok: false, reason: `node-pty is not available: ${(err as Error).message}` };
  }
  const holder = holderScriptPath();
  if (!existsSync(holder)) return { ok: false, reason: `Terminal holder not built: ${holder}` };
  return { ok: true };
}

export interface PiTerminalStartOptions {
  piBin?: string;
  cwd: string;
  /** Pi arguments (without `-e <terminal extension>`, which is appended). */
  args: string[];
  env?: Record<string, string | undefined>;
  runtimeDir?: string;
  /** Holder log (default `<socket dir>/<socket name>.log`). */
  logPath?: string;
  cols?: number;
  rows?: number;
  /** Abort to stop waiting for the holder: it is killed and the start rejects. */
  signal?: AbortSignal;
}

interface PendingRequest {
  command: string;
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

function connectOnce(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const timer = setTimeout(() => {
      s.destroy();
      reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Where a holder leaves Pi's exit when no host agent was there to hear it. */
export function holderExitPath(socketPath: string): string {
  return `${socketPath}.exit.json`;
}

/** Pi's exit as a holder saved it, or null. Does not delete the file. */
export function readHolderExit(
  socketPath: string,
): { code: number | null; signal: NodeJS.Signals | null; screen: string[] } | null {
  try {
    const rec = JSON.parse(readFileSync(holderExitPath(socketPath), "utf8"));
    if (!rec || typeof rec !== "object") return null;
    return {
      code: typeof rec.code === "number" ? rec.code : null,
      signal: typeof rec.signal === "string" ? (rec.signal as NodeJS.Signals) : null,
      screen: Array.isArray(rec.screen)
        ? rec.screen.filter((l: unknown) => typeof l === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function logTail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    return "";
  }
}

const MAX_RECONNECTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Interactive Pi in a Switchyard terminal holder, controlled through the Switchyard terminal
 * extension. Same command and event surface as `PiRpcProcess`; the process belongs to the holder,
 * so `detach()` lets a host agent go away and `attach()` come back.
 *
 * Extra events: `ui_closed` ({id, by}), `gap` (holder dropped buffered records), `capabilities`
 * ({remoteDialogs}).
 */
export class PiTerminalProcess extends EventEmitter implements PiTransport {
  readonly socketPath: string;
  pid: number | undefined = undefined;
  bridgeConnected = false;
  remoteDialogs = false;
  readonly stderr = "";
  private socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private seq = 0;
  private closeRequested = false;
  private detached = false;
  private reconnects = 0;
  /** Set when close() gave up on the holder: a closed socket then ends the session. */
  private abandoned = false;
  private exitInfo: PiExit | null = null;
  private resolveExit!: (info: PiExit) => void;
  private readonly exitPromise: Promise<PiExit>;

  private constructor(socketPath: string, socket: Socket) {
    super();
    this.socketPath = socketPath;
    this.socket = socket;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.bind(socket);
  }

  /** Wire a control socket: records in, close handling (reconnect, then give up), role hello. */
  private bind(socket: Socket): void {
    socket.on("error", () => {
      // surfaced through close
    });
    JsonlReader.attach(
      socket,
      (record) => this.onRecord(record),
      (err, line) => this.emit("protocol_error", err, line),
    );
    socket.on("close", () => {
      if (this.detached || this.exitInfo || socket !== this.socket) return;
      if (this.abandoned || this.reconnects >= MAX_RECONNECTS) {
        this.finishLost();
        return;
      }
      void this.reconnect();
    });
    socket.write(`${JSON.stringify({ role: "control" })}\n`);
  }

  /**
   * The control socket closed while Pi was still running (a hiccup, or a second controller): the
   * holder buffers the extension's output until a control attaches, so reconnect and carry on.
   */
  private async reconnect(): Promise<void> {
    this.reconnects++;
    for (let i = 0; i < 3; i++) {
      try {
        const s = await connectOnce(this.socketPath, 1000);
        if (this.detached || this.exitInfo) {
          s.destroy();
          return;
        }
        this.socket = s;
        this.bind(s);
        this.emit("reconnected");
        return;
      } catch {
        await sleep(200);
      }
    }
    this.finishLost();
  }

  /** The holder is gone: report what it saved of Pi's exit, if anything. */
  private finishLost(): void {
    const saved = readHolderExit(this.socketPath);
    this.finish({
      code: saved?.code ?? null,
      signal: saved?.signal ?? null,
      requested: this.closeRequested,
      screen: saved?.screen,
    });
  }

  /** Start a holder running interactive Pi and attach to it. */
  static async start(opts: PiTerminalStartOptions): Promise<PiTerminalProcess> {
    const runtimeDir = opts.runtimeDir ?? join(tmpdir(), "switchyard");
    const socketPath = shortSocketPath(runtimeDir, "term");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) {
      if (v !== undefined) env[k] = v;
    }
    delete env.SWITCHYARD_BRIDGE_SOCKET;
    delete env.SWITCHYARD_HOLDER_CONFIG;
    env.SWITCHYARD_CONTROL_SOCKET = socketPath;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    const cfg = {
      socketPath,
      piBin: opts.piBin ?? "pi",
      args: [...opts.args, "-e", terminalExtensionPath()],
      cwd: opts.cwd,
      env,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      sizing: ((v) => (v === "latest" || v === "smallest" ? v : "owner"))(
        process.env.SWITCHYARD_TERMINAL_SIZING,
      ),
    };
    const logPath =
      opts.logPath ?? join(dirname(socketPath), `${basename(socketPath, ".sock")}.log`);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const fd = openSync(logPath, "a", 0o600);
    let holderPid: number | undefined;
    try {
      const child = spawn(process.execPath, [holderScriptPath()], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, SWITCHYARD_HOLDER_CONFIG: JSON.stringify(cfg) },
      });
      child.on("error", () => {
        // reported by the connect timeout below
      });
      holderPid = child.pid;
      child.unref();
    } finally {
      closeSync(fd);
    }
    // The holder's SIGTERM handler stops Pi, or exits at once when Pi was never spawned.
    const killHolder = () => {
      if (holderPid === undefined) return;
      try {
        process.kill(holderPid, "SIGTERM");
      } catch {
        // already gone
      }
    };
    const deadline = Date.now() + 10_000;
    const canceled = () => {
      killHolder();
      return new PiRpcError("spawn", START_CANCELED, "transport");
    };
    for (;;) {
      if (opts.signal?.aborted) throw canceled();
      try {
        const socket = await connectOnce(socketPath, 1000);
        return new PiTerminalProcess(socketPath, socket);
      } catch {
        if (opts.signal?.aborted) throw canceled();
        if (Date.now() > deadline) {
          const tail = logTail(logPath);
          killHolder();
          throw new PiRpcError(
            "spawn",
            `Terminal holder did not start${tail ? `: ${tail}` : ""} (log: ${logPath})`,
            "transport",
          );
        }
        await sleep(100);
      }
    }
  }

  /** Attach to a running holder (after a host-agent restart). */
  static async attach(socketPath: string, timeoutMs = 3000): Promise<PiTerminalProcess> {
    let socket: Socket;
    try {
      socket = await connectOnce(socketPath, timeoutMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        const saved = readHolderExit(socketPath);
        if (saved) {
          rmSync(holderExitPath(socketPath), { force: true });
          throw new PiRpcError(
            "attach",
            `Pi exited while the host agent was away (code ${saved.code}, signal ${saved.signal})${screenTail(saved.screen)}`,
            "transport",
          );
        }
        throw new PiRpcError("attach", "Terminal holder not running", "transport");
      }
      throw new PiRpcError(
        "attach",
        `Cannot reach the terminal holder: ${(err as Error).message}`,
        "transport",
      );
    }
    return new PiTerminalProcess(socketPath, socket);
  }

  get exited(): PiExit | null {
    return this.exitInfo;
  }

  waitForExit(): Promise<PiExit> {
    return this.exitPromise;
  }

  request<T = any>(cmd: { type: string; [key: string]: unknown }, timeoutMs = 60000): Promise<T> {
    if (this.exitInfo || this.detached) {
      return Promise.reject(new PiRpcError(cmd.type, "Pi is not running", "transport"));
    }
    const id = `sy-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      // No timer for `timeoutMs <= 0` (or not finite): setTimeout would fire at once.
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new PiRpcError(
                  cmd.type,
                  `Pi did not answer ${cmd.type} within ${timeoutMs} ms`,
                  "timeout",
                ),
              );
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { command: cmd.type, resolve, reject, timer });
      writeJsonl(this.socket, { ...cmd, id }).catch((err: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(new PiRpcError(cmd.type, `Could not write to Pi: ${err.message}`, "transport"));
      });
    });
  }

  respondUi(id: string, body: PiUiResponseBody): Promise<void> {
    return writeJsonl(this.socket, { type: "extension_ui_response", id, ...body });
  }

  /** Ask Pi to quit, then SIGTERM, then SIGKILL through the holder. */
  async close(opts: { graceMs?: number; termMs?: number } = {}): Promise<PiExit> {
    this.closeRequested = true;
    if (this.exitInfo) return this.exitInfo;
    const graceMs = opts.graceMs ?? 10000;
    const termMs = opts.termMs ?? 3000;
    const wait = (ms: number) =>
      Promise.race([this.exitPromise, sleep(ms).then(() => null as PiExit | null)]);
    this.request({ type: "shutdown" }, 5000).catch(() => {});
    let info = await wait(graceMs);
    if (info) return info;
    this.kill("SIGTERM");
    info = await wait(termMs);
    if (info) return info;
    this.kill("SIGKILL");
    info = await wait(5000);
    if (info) return info;
    this.abandoned = true;
    this.socket.destroy();
    return this.exitPromise;
  }

  kill(signal: NodeJS.Signals = "SIGTERM", requested = false): void {
    if (requested) this.closeRequested = true;
    writeJsonl(this.socket, { type: "holder_kill", signal }).catch(() => {});
  }

  /** Let go of the holder without stopping Pi; no `exit` is emitted. */
  detach(): void {
    this.detached = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PiRpcError(p.command, "Detached from the terminal holder", "transport"));
    }
    this.pending.clear();
    this.socket.destroy();
  }

  private finish(info: PiExit): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    const reason = `Pi exited (code ${info.code}, signal ${info.signal})${screenTail(info.screen)}`;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PiRpcError(p.command, reason, "transport"));
    }
    this.pending.clear();
    this.socket.destroy();
    this.resolveExit(info);
    this.emit("exit", info);
  }

  private onRecord(record: unknown): void {
    if (!record || typeof record !== "object") return;
    const rec = record as Record<string, any>;
    switch (rec.type) {
      case "response": {
        const id = typeof rec.id === "string" ? rec.id : undefined;
        const p = id ? this.pending.get(id) : undefined;
        if (!p || !id) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (rec.success === false) {
          // `holder: true` marks a failure of the holder itself, not Pi's answer.
          p.reject(
            new PiRpcError(
              p.command,
              String(rec.error),
              rec.holder === true ? "transport" : "rejected",
            ),
          );
        } else p.resolve(rec.data);
        return;
      }
      case "extension_ui_request":
        this.emit("ui_request", rec as PiUiRequest);
        return;
      case "extension_ui_closed":
        this.emit("ui_closed", { id: String(rec.id), by: rec.by === "pi" ? "pi" : "terminal" });
        return;
      case "ui_prompt": {
        const ev: BridgeEvent = {
          type: rec.event === "ui_prompt_end" ? "ui_prompt_end" : "ui_prompt_start",
          kind: typeof rec.kind === "string" ? rec.kind : "unknown",
          title: typeof rec.title === "string" ? rec.title : null,
          remoteBacked: rec.remoteBacked === true,
          seq: ++this.seq,
          at: new Date().toISOString(),
          pid: this.pid ?? 0,
        } as BridgeEvent;
        this.emit("bridge", ev);
        return;
      }
      case "extension_hello": {
        this.bridgeConnected = true;
        this.remoteDialogs = rec.remoteDialogs === true;
        this.emit("bridge", {
          type: "hello",
          title: null,
          seq: ++this.seq,
          at: new Date().toISOString(),
          pid: typeof rec.pid === "number" ? rec.pid : (this.pid ?? 0),
        } as BridgeEvent);
        this.emit("capabilities", { remoteDialogs: this.remoteDialogs });
        return;
      }
      case "holder_status":
        if (typeof rec.piPid === "number") this.pid = rec.piPid;
        return;
      case "holder_gap":
        this.emit("gap");
        return;
      case "holder_exit":
        this.finish({
          code: typeof rec.code === "number" ? rec.code : null,
          signal: typeof rec.signal === "string" ? (rec.signal as NodeJS.Signals) : null,
          requested: this.closeRequested,
          screen: Array.isArray(rec.screen)
            ? rec.screen.filter((l: unknown) => typeof l === "string")
            : undefined,
        });
        return;
      default:
        this.emit("event", rec);
    }
  }
}

export interface HolderSweep {
  /** Holders nobody referenced, stopped. */
  killed: string[];
  /** Dead sockets removed. */
  removed: string[];
  /** Sockets that accept a connection but never answered (left alone). */
  unreachable: string[];
  /** Exit files and old logs deleted. */
  filesDeleted: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stop terminal holders no session record refers to (their Pi session file is safe on disk, so at
 * most an in-flight turn is lost), remove dead sockets, and delete exit files and old logs that
 * belong to no kept holder. `dirs` must be directories this agent alone writes sockets to (see
 * `socketDirs`), and `keep` the socket paths still in use.
 */
export async function sweepHolders(opts: {
  dirs: string[];
  keep: Set<string>;
  /** Logs of unreferenced holders older than this are deleted (default 7 days). */
  maxAgeMs?: number;
  now?: number;
}): Promise<HolderSweep> {
  const out: HolderSweep = { killed: [], removed: [], unreachable: [], filesDeleted: 0 };
  const keep = new Set([...opts.keep].map((p) => resolve(p)));
  const maxAgeMs = opts.maxAgeMs ?? SEVEN_DAYS_MS;
  const now = opts.now ?? Date.now();
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const dir of opts.dirs) {
    const socks = list(dir).filter((f) => /^term-.*\.sock$/.test(f));
    await Promise.all(
      socks.map(async (f) => {
        const path = join(dir, f);
        if (keep.has(resolve(path))) return;
        try {
          const probe = await connectOnce(path, 1000);
          probe.destroy();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK") {
            rmSync(path, { force: true });
            out.removed.push(path);
          } else {
            out.unreachable.push(path);
          }
          return;
        }
        let proc: PiTerminalProcess;
        try {
          proc = await PiTerminalProcess.attach(path, 1000);
        } catch {
          out.unreachable.push(path);
          return;
        }
        const exited = (ms: number) =>
          Promise.race([proc.waitForExit().then(() => true), sleep(ms).then(() => false)]);
        proc.kill("SIGTERM", true);
        if (!(await exited(3000))) {
          proc.kill("SIGKILL", true);
          if (!(await exited(2000))) proc.detach();
        }
        out.killed.push(path);
      }),
    );
    for (const f of list(dir)) {
      const path = join(dir, f);
      const sock = f.replace(/\.exit\.json$/, "").replace(/\.log$/, ".sock");
      if (keep.has(resolve(join(dir, sock)))) continue;
      try {
        if (/^term-.*\.sock\.exit\.json$/.test(f)) {
          rmSync(path, { force: true });
          out.filesDeleted++;
        } else if (/^term-.*\.log$/.test(f) && now - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { force: true });
          out.filesDeleted++;
        }
      } catch {
        // best effort
      }
    }
  }
  return out;
}
