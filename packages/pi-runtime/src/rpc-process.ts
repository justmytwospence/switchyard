import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, type Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlReader, writeJsonl } from "./jsonl.js";
import type { BridgeEvent, PiEvent, PiUiRequest, PiUiResponseBody } from "./types.js";

/** Absolute path of the compiled bridge extension loaded into every managed Pi. */
export function bridgeExtensionPath(): string {
  const sibling = fileURLToPath(new URL("./bridge/switchyard-bridge.js", import.meta.url));
  if (existsSync(sibling)) return sibling;
  // Running from src/ (tests): use the compiled copy.
  return fileURLToPath(new URL("../dist/bridge/switchyard-bridge.js", import.meta.url));
}

export interface PiRpcStartOptions {
  /** Pi binary (default `pi`). */
  piBin?: string;
  cwd: string;
  /** Arguments after `--mode rpc`; the bridge `-e` is appended unless `bridge` is false. */
  args?: string[];
  /** Extra environment, merged over `process.env`. `undefined` values remove a variable. */
  env?: Record<string, string | undefined>;
  /** Directory for the bridge socket (default `<tmpdir>/switchyard`). */
  runtimeDir?: string;
  /** Load the bridge extension and listen on its socket (default true). */
  bridge?: boolean;
}

export interface PiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when `close()`/`kill()` was requested by us. */
  requested: boolean;
}

/** Error from a Pi command answered with `success:false`, or a transport failure. */
export class PiRpcError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "PiRpcError";
    this.command = command;
  }
}

interface PendingRequest {
  command: string;
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_SOCKET_PATH = 100;

/** Short fallback for long runtime dirs: one private subdirectory per runtime dir, so agents never share it. */
export function fallbackSocketDir(runtimeDir: string): string {
  const hash = createHash("sha256").update(resolve(runtimeDir)).digest("hex").slice(0, 8);
  return join("/tmp", `switchyard-${process.getuid?.() ?? "u"}`, hash);
}

/** Directories a runtime dir's sockets can live in (for sweeps). */
export function socketDirs(runtimeDir: string): string[] {
  return [runtimeDir, fallbackSocketDir(runtimeDir)];
}

/** Pure check: "ok", "chmod" (ours but looser than 0700), or throws. */
export function checkPrivateDir(
  dir: string,
  st: Pick<Stats, "uid" | "mode" | "isDirectory" | "isSymbolicLink">,
  uid: number | undefined,
): "ok" | "chmod" {
  if (st.isSymbolicLink())
    throw new Error(
      `Socket directory ${dir} is a symlink; remove it so Switchyard can create a private directory`,
    );
  if (!st.isDirectory())
    throw new Error(
      `Socket directory ${dir} is not a directory; remove it so Switchyard can create a private directory`,
    );
  if (uid !== undefined && st.uid !== uid)
    throw new Error(
      `Socket directory ${dir} belongs to uid ${st.uid}, not ${uid}; remove it or use a shorter SWITCHYARD_STATE_DIR`,
    );
  return (st.mode & 0o077) !== 0 ? "chmod" : "ok";
}

/** Create `dir` (0700) if missing, then require: not a symlink, a directory, ours, mode 0700 (tightened if looser). */
export function ensurePrivateDir(dir: string): void {
  let st: Stats | null = null;
  try {
    st = lstatSync(dir);
  } catch {
    /* missing */
  }
  if (!st) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (checkPrivateDir(dir, st, process.getuid?.()) === "chmod") chmodSync(dir, 0o700);
}

/** A fresh Unix socket path in `runtimeDir`, or in a short private `/tmp` directory when that is too long. */
export function shortSocketPath(runtimeDir: string, prefix: string): string {
  const name = `${prefix}-${randomUUID().slice(0, 8)}.sock`;
  if (join(runtimeDir, name).length <= MAX_SOCKET_PATH) {
    ensurePrivateDir(runtimeDir);
    return join(runtimeDir, name);
  }
  // Unix socket paths are limited (104 bytes on macOS); fall back to a short directory.
  const dir = fallbackSocketDir(runtimeDir);
  ensurePrivateDir(dirname(dir)); // /tmp/switchyard-<uid>
  ensurePrivateDir(dir);
  return join(dir, name);
}

/**
 * One `pi --mode rpc` child process: JSONL commands with id correlation, events,
 * extension UI requests, and the bridge socket.
 *
 * Events: `event` (PiEvent), `ui_request` (PiUiRequest), `bridge` (BridgeEvent),
 * `stderr` (string), `exit` (PiExit), `protocol_error` (Error, line).
 */
export class PiRpcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly bridgeSocket: string | null;
  private readonly server: Server | null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly bridgeSockets = new Set<Socket>();
  private nextId = 0;
  private closeRequested = false;
  private exitInfo: PiExit | null = null;
  private readonly exitPromise: Promise<PiExit>;
  private stderrTail = "";
  /** True once the bridge extension connected and said hello. */
  bridgeConnected = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    server: Server | null,
    socketPath: string | null,
  ) {
    super();
    this.child = child;
    this.server = server;
    this.bridgeSocket = socketPath;
    this.exitPromise = new Promise<PiExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal, requested: this.closeRequested };
        resolve(this.exitInfo);
      });
    });
    JsonlReader.attach(
      child.stdout,
      (record) => this.onRecord(record),
      (err, line) => this.emit("protocol_error", err, line),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-8192);
      this.emit("stderr", text);
    });
    child.stdin.on("error", () => {
      // EPIPE after exit; surfaced through `exit`.
    });
    void this.exitPromise.then((info) => {
      const reason = `Pi exited (code ${info.code}, signal ${info.signal})${
        this.stderrTail.trim()
          ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}`
          : ""
      }`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new PiRpcError(p.command, reason));
      }
      this.pending.clear();
      this.cleanupBridge();
      this.emit("exit", info);
    });
  }

  /** Spawn `pi --mode rpc ...args -e <bridge>` with the bridge socket listening first. */
  static async start(opts: PiRpcStartOptions): Promise<PiRpcProcess> {
    const useBridge = opts.bridge !== false;
    let server: Server | null = null;
    let socketPath: string | null = null;
    let proc: PiRpcProcess | null = null;
    const early: Socket[] = [];
    if (useBridge) {
      socketPath = shortSocketPath(opts.runtimeDir ?? join(tmpdir(), "switchyard"), "bridge");
      server = createServer((socket) => {
        if (proc) proc.attachBridgeSocket(socket);
        else early.push(socket);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath!, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // best effort
      }
    }
    const args = ["--mode", "rpc", ...(opts.args ?? [])];
    if (useBridge) args.push("-e", bridgeExtensionPath());
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) {
      if (v !== undefined) env[k] = v;
    }
    if (socketPath) env.SWITCHYARD_BRIDGE_SOCKET = socketPath;
    else delete env.SWITCHYARD_BRIDGE_SOCKET;

    const child = spawn(opts.piBin ?? "pi", args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
          child.off("error", reject);
          resolve();
        });
        child.once("error", reject);
      });
    } catch (err) {
      server?.close();
      if (socketPath) rmSync(socketPath, { force: true });
      throw new PiRpcError("spawn", `Could not start Pi: ${(err as Error).message}`);
    }
    child.on("error", () => {
      // post-spawn errors (e.g. kill failures) are reflected by `exit`
    });
    proc = new PiRpcProcess(child, server, socketPath);
    for (const s of early) proc.attachBridgeSocket(s);
    return proc;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): PiExit | null {
    return this.exitInfo;
  }

  /** Last stderr output (up to 8 KB), for diagnostics. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Resolves when the child exits. */
  waitForExit(): Promise<PiExit> {
    return this.exitPromise;
  }

  /** Send a command and resolve with its `data`; rejects with Pi's error string on `success:false`. */
  request<T = any>(cmd: { type: string; [key: string]: unknown }, timeoutMs = 60000): Promise<T> {
    if (this.exitInfo) {
      return Promise.reject(new PiRpcError(cmd.type, "Pi is not running"));
    }
    const id = `sy-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(cmd.type, `Pi did not answer ${cmd.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { command: cmd.type, resolve, reject, timer });
      writeJsonl(this.child.stdin, { ...cmd, id }).catch((err: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(new PiRpcError(cmd.type, `Could not write to Pi: ${err.message}`));
      });
    });
  }

  /** Answer a dialog `extension_ui_request`. */
  respondUi(id: string, body: PiUiResponseBody): Promise<void> {
    return writeJsonl(this.child.stdin, { type: "extension_ui_response", id, ...body });
  }

  /**
   * Orderly shutdown: end stdin, wait `graceMs` (default 10 s), then SIGTERM, then SIGKILL after
   * `termMs` (default 3 s).
   */
  async close(opts: { graceMs?: number; termMs?: number } = {}): Promise<PiExit> {
    this.closeRequested = true;
    if (this.exitInfo) return this.exitInfo;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const graceMs = opts.graceMs ?? 10000;
    const termMs = opts.termMs ?? 3000;
    const timeout = (ms: number) =>
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref());
    let info = await Promise.race([this.exitPromise, timeout(graceMs)]);
    if (info) return info;
    this.child.kill("SIGTERM");
    info = await Promise.race([this.exitPromise, timeout(termMs)]);
    if (info) return info;
    this.child.kill("SIGKILL");
    return this.exitPromise;
  }

  /** Send a signal. Not counted as a requested close (an external kill is unexpected). */
  kill(signal: NodeJS.Signals = "SIGTERM", requested = false): void {
    if (requested) this.closeRequested = true;
    this.child.kill(signal);
  }

  private attachBridgeSocket(socket: Socket): void {
    this.bridgeSockets.add(socket);
    socket.on("close", () => this.bridgeSockets.delete(socket));
    socket.on("error", () => {
      // the bridge disables itself; nothing to do here
    });
    JsonlReader.attach(socket, (record) => {
      const msg = record as BridgeEvent;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (msg.type === "hello") {
        this.bridgeConnected = true;
      }
      this.emit("bridge", msg);
    });
  }

  private cleanupBridge(): void {
    for (const s of this.bridgeSockets) s.destroy();
    this.bridgeSockets.clear();
    if (this.server) {
      this.server.close();
    }
    if (this.bridgeSocket) rmSync(this.bridgeSocket, { force: true });
  }

  private onRecord(record: unknown): void {
    if (!record || typeof record !== "object") return;
    const rec = record as Record<string, any>;
    if (rec.type === "response") {
      const id = typeof rec.id === "string" ? rec.id : undefined;
      const p = id ? this.pending.get(id) : undefined;
      if (!p || !id) {
        if (rec.success === false) {
          this.emit("protocol_error", new Error(String(rec.error ?? "unknown error")), "");
        }
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (rec.success === false) p.reject(new PiRpcError(p.command, String(rec.error)));
      else p.resolve(rec.data);
      return;
    }
    if (rec.type === "extension_ui_request") {
      this.emit("ui_request", rec as PiUiRequest);
      return;
    }
    this.emit("event", rec as PiEvent);
  }
}
