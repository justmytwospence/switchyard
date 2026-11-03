import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlReader, writeJsonl } from "./jsonl.js";
import { type PiExit, PiRpcError, shortSocketPath } from "./rpc-process.js";
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
}

interface PendingRequest {
  command: string;
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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

function logTail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    return "";
  }
}

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
    socket.on("error", () => {
      // surfaced through close
    });
    JsonlReader.attach(
      socket,
      (record) => this.onRecord(record),
      (err, line) => this.emit("protocol_error", err, line),
    );
    socket.on("close", () => {
      if (this.detached) return;
      this.finish({ code: null, signal: null, requested: this.closeRequested });
    });
    socket.write(`${JSON.stringify({ role: "control" })}\n`);
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
    };
    const logPath =
      opts.logPath ?? join(dirname(socketPath), `${basename(socketPath, ".sock")}.log`);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const fd = openSync(logPath, "a", 0o600);
    try {
      const child = spawn(process.execPath, [holderScriptPath()], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, SWITCHYARD_HOLDER_CONFIG: JSON.stringify(cfg) },
      });
      child.on("error", () => {
        // reported by the connect timeout below
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const socket = await connectOnce(socketPath, 1000);
        return new PiTerminalProcess(socketPath, socket);
      } catch {
        if (Date.now() > deadline) {
          const tail = logTail(logPath);
          throw new PiRpcError(
            "spawn",
            `Terminal holder did not start${tail ? `: ${tail}` : ""} (log: ${logPath})`,
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
      throw new PiRpcError(
        "attach",
        code === "ENOENT" || code === "ECONNREFUSED"
          ? "Terminal holder not running"
          : `Cannot reach the terminal holder: ${(err as Error).message}`,
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
      return Promise.reject(new PiRpcError(cmd.type, "Pi is not running"));
    }
    const id = `sy-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(cmd.type, `Pi did not answer ${cmd.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { command: cmd.type, resolve, reject, timer });
      writeJsonl(this.socket, { ...cmd, id }).catch((err: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(new PiRpcError(cmd.type, `Could not write to Pi: ${err.message}`));
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
      p.reject(new PiRpcError(p.command, "Detached from the terminal holder"));
    }
    this.pending.clear();
    this.socket.destroy();
  }

  private finish(info: PiExit): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    const reason = `Pi exited (code ${info.code}, signal ${info.signal})`;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PiRpcError(p.command, reason));
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
        if (rec.success === false) p.reject(new PiRpcError(p.command, String(rec.error)));
        else p.resolve(rec.data);
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
        });
        return;
      default:
        this.emit("event", rec);
    }
  }
}
