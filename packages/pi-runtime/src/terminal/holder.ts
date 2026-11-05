/**
 * Switchyard terminal holder: one detached process per terminal session. It owns the pty in which
 * interactive Pi runs and a Unix socket with three kinds of connections, each opened with a JSON
 * hello line:
 *
 * - `{"role":"extension"}`: the Switchyard extension inside Pi (the control channel's Pi side);
 * - `{"role":"control"}`: the host agent; records flow between it and the extension. While no
 *   host agent is attached, extension output is buffered, so a host-agent restart loses nothing;
 * - `{"role":"viewer","cols":C,"rows":R}`: a terminal client; `{t:"in"|"resize"}` in,
 *   `{t:"out"|"closed"}` out. A headless xterm keeps the screen to paint new viewers.
 *
 * Config comes from `SWITCHYARD_HOLDER_CONFIG` (JSON). Spawned detached by `PiTerminalProcess`,
 * so it outlives the host agent.
 */
import { chmodSync, existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter } from "../bridge/lines.js";

const require = createRequire(import.meta.url);

export interface HolderConfig {
  socketPath: string;
  piBin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Several viewers: the smallest one sizes the pty (default), or the latest to report. */
  sizing?: "smallest" | "latest";
}

/**
 * The part of node-pty the holder uses. node-pty is an optional dependency (it may be absent where
 * it cannot be built), so its types are not imported.
 */
interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): Pty;
}

const MAX_BUFFER = 20_000;
const MAX_TO_EXTENSION = 1000;
const EXIT_WAIT_MS = 5 * 60_000;

export const HOLDER_QUEUE_FULL =
  "Pi's Switchyard extension is not connected and too many commands are waiting";

/** node-pty's prebuilt `spawn-helper` must be executable; some installs drop the mode bits. */
export function ensureSpawnHelper(req: NodeJS.Require = require): void {
  try {
    const root = dirname(req.resolve("node-pty/package.json"));
    for (const p of [
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ]) {
      if (existsSync(p) && (statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
    }
  } catch {
    // node-pty reports its own error on spawn
  }
}

function signalName(signal: number): string {
  for (const [name, n] of Object.entries(constants.signals)) if (n === signal) return name;
  return String(signal);
}

function lineReader(socket: Socket, onLine: (line: string) => void): void {
  const lines = new LineSplitter(onLine);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => lines.push(chunk));
}

function write(socket: Socket | null, line: string): void {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`${line}\n`);
  } catch {
    // closed meanwhile
  }
}

/** The last `n` non-empty lines of a terminal's active buffer (what Pi last showed). */
export function lastScreenLines(
  term: {
    buffer: {
      active: {
        length: number;
        getLine(i: number): { translateToString(trim?: boolean): string } | undefined;
      };
    };
  },
  n = 20,
): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = buf.length - 1; i >= 0 && out.length < n; i--) {
    const text = buf.getLine(i)?.translateToString(true).trimEnd() ?? "";
    if (text.trim()) out.unshift(text);
  }
  return out;
}

export function runHolder(cfg: HolderConfig): void {
  ensureSpawnHelper();
  const pty = require("node-pty") as PtyModule;
  const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
  const { SerializeAddon } =
    require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

  rmSync(cfg.socketPath, { force: true });

  let control: Socket | null = null;
  let extension: Socket | null = null;
  const viewers = new Set<Socket>();
  const buffer: string[] = [];
  const toExtension: string[] = [];
  let gap = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  /** The `holder_exit` line, with Pi's last screen lines, once Pi has exited. */
  let exitRecord: string | null = null;
  let shuttingDown = false;
  const exitPath = `${cfg.socketPath}.exit.json`;
  /** True once a control has been sent the exit record; until then it stays on disk. */
  let exitDelivered = false;

  const term = new Terminal({
    cols: cfg.cols,
    rows: cfg.rows,
    scrollback: 2000,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer as never);

  let proc: Pty | null = null;
  let killRequested = false;

  const resize = (cols: number, rows: number) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    if (exitInfo || !proc) return;
    try {
      proc.resize(cols, rows);
      term.resize(cols, rows);
    } catch {
      // the pty may be closing
    }
  };

  const sizes = new Map<Socket, { cols: number; rows: number }>();
  /** Size the pty for the attached viewers; `from` is the viewer that just reported. */
  const apply = (from?: Socket) => {
    if (cfg.sizing === "latest") {
      const z = from ? sizes.get(from) : undefined;
      if (z) resize(z.cols, z.rows);
      return;
    }
    if (sizes.size === 0) return;
    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;
    for (const z of sizes.values()) {
      cols = Math.min(cols, z.cols);
      rows = Math.min(rows, z.rows);
    }
    resize(cols, rows);
  };
  const report = (socket: Socket, cols: number, rows: number) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    sizes.set(socket, { cols, rows });
    apply(socket);
  };

  const toControl = (line: string) => {
    if (control && !control.destroyed) {
      write(control, line);
      return;
    }
    buffer.push(line);
    if (buffer.length > MAX_BUFFER) {
      buffer.shift();
      gap = true;
    }
  };

  const sendExtension = (line: string, rec: any) => {
    if (extension && !extension.destroyed) {
      write(extension, line);
      return;
    }
    if (toExtension.length >= MAX_TO_EXTENSION) {
      // Reject the newest; the commands already accepted keep their FIFO order.
      if (
        rec &&
        typeof rec.id === "string" &&
        typeof rec.type === "string" &&
        rec.type !== "extension_ui_response"
      ) {
        write(
          control,
          JSON.stringify({
            type: "response",
            id: rec.id,
            command: rec.type,
            success: false,
            error: HOLDER_QUEUE_FULL,
            holder: true,
          }),
        );
      }
      return;
    }
    toExtension.push(line);
  };

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const v of viewers) v.end();
    try {
      server.close();
    } catch {
      // ignore
    }
    rmSync(cfg.socketPath, { force: true });
    if (exitDelivered) rmSync(exitPath, { force: true });
    setTimeout(() => process.exit(0), 100).unref();
  };

  const onPiExit = (
    { exitCode, signal }: { exitCode: number | null; signal?: number },
    extra?: string[],
  ) => {
    // Refuse input at once; the record follows when the terminal has parsed Pi's last output.
    exitInfo = { code: exitCode ?? null, signal: signal ? signalName(signal) : null };
    term.write("", () => {
      const screen = extra ?? lastScreenLines(term);
      exitRecord = JSON.stringify({ type: "holder_exit", ...exitInfo, screen });
      try {
        writeFileSync(
          exitPath,
          JSON.stringify({ ...exitInfo, screen, at: new Date().toISOString() }),
          {
            mode: 0o600,
          },
        );
      } catch {
        // best effort
      }
      const closed = JSON.stringify({ t: "closed", reason: "Pi exited" });
      for (const v of viewers) {
        write(v, closed);
        v.end();
      }
      viewers.clear();
      if (control && !control.destroyed) {
        write(control, exitRecord);
        exitDelivered = true;
        setTimeout(shutdown, 1000).unref();
      } else {
        setTimeout(shutdown, killRequested ? 1000 : EXIT_WAIT_MS).unref();
      }
    });
  };

  /** Spawn Pi once the socket is listening, so the extension can always connect. */
  const startPi = () => {
    try {
      proc = pty.spawn(cfg.piBin, cfg.args, {
        name: "xterm-256color",
        cols: cfg.cols,
        rows: cfg.rows,
        cwd: cfg.cwd,
        env: cfg.env,
      });
    } catch (err) {
      process.stderr.write(
        `switchyard holder: could not start ${cfg.piBin}: ${(err as Error).message}\n`,
      );
      onPiExit({ exitCode: null }, [`Could not start ${cfg.piBin}: ${(err as Error).message}`]);
      return;
    }
    const started = proc;
    started.onData((d: string) => {
      term.write(d);
      if (viewers.size === 0) return;
      const line = JSON.stringify({ t: "out", d: Buffer.from(d, "utf8").toString("base64") });
      for (const v of viewers) write(v, line);
    });
    started.onExit(onPiExit);
    if (control && !control.destroyed) {
      write(control, JSON.stringify({ type: "holder_status", piPid: started.pid }));
    }
  };

  const server = createServer((socket) => {
    let role: "extension" | "control" | "viewer" | null = null;
    socket.on("error", () => {
      // peer went away
    });
    lineReader(socket, (line) => {
      if (role === null) {
        let hello: any;
        try {
          hello = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (hello?.role === "extension") {
          role = "extension";
          if (extension && extension !== socket) extension.destroy();
          extension = socket;
          for (const l of toExtension.splice(0)) write(socket, l);
        } else if (hello?.role === "control") {
          role = "control";
          if (control && control !== socket) control.destroy();
          control = socket;
          write(socket, JSON.stringify({ type: "holder_status", piPid: proc?.pid ?? null }));
          if (gap) {
            write(socket, JSON.stringify({ type: "holder_gap" }));
            gap = false;
          }
          for (const l of buffer.splice(0)) write(socket, l);
          if (exitRecord) {
            write(socket, exitRecord);
            exitDelivered = true;
            setTimeout(shutdown, 1000).unref();
          }
          if (extension && !extension.destroyed) {
            write(extension, JSON.stringify({ type: "control_attached" }));
          }
        } else if (hello?.role === "viewer") {
          role = "viewer";
          if (exitInfo) {
            write(socket, JSON.stringify({ t: "closed", reason: "Pi exited" }));
            socket.end();
            return;
          }
          viewers.add(socket);
          report(socket, Number(hello.cols), Number(hello.rows));
          // Paint the current screen once the resize has been applied.
          setImmediate(() => {
            try {
              const screen = serializer.serialize();
              write(
                socket,
                JSON.stringify({ t: "out", d: Buffer.from(screen, "utf8").toString("base64") }),
              );
            } catch {
              // ignore
            }
          });
        } else {
          socket.destroy();
        }
        return;
      }
      if (role === "extension") {
        let rec: any = null;
        try {
          rec = JSON.parse(line);
        } catch {
          // forward as-is
        }
        if (rec?.type === "holder_keys") {
          if (!exitInfo && proc && typeof rec.data === "string") proc.write(rec.data);
          return;
        }
        toControl(line);
        return;
      }
      if (role === "control") {
        let rec: any = null;
        try {
          rec = JSON.parse(line);
        } catch {
          // forward as-is
        }
        if (rec?.type === "holder_kill") {
          try {
            proc?.kill(typeof rec.signal === "string" ? rec.signal : "SIGTERM");
          } catch {
            // already gone
          }
          return;
        }
        sendExtension(line, rec);
        return;
      }
      // viewer
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.t === "in" && typeof msg.d === "string") {
        if (!exitInfo && proc) proc.write(Buffer.from(msg.d, "base64").toString("utf8"));
      } else if (msg?.t === "resize") {
        report(socket, Number(msg.cols), Number(msg.rows));
      }
    });
    socket.on("close", () => {
      if (role === "viewer") {
        viewers.delete(socket);
        if (sizes.delete(socket)) apply();
      } else if (role === "control" && control === socket) control = null;
      else if (role === "extension" && extension === socket) extension = null;
    });
  });

  server.on("error", (err) => {
    process.stderr.write(`switchyard holder: cannot listen on ${cfg.socketPath}: ${err.message}\n`);
    process.exit(1);
  });
  // Listen with a restrictive umask, then spawn Pi with the original one.
  const oldMask = process.umask(0o077);
  server.listen(cfg.socketPath, () => {
    process.umask(oldMask);
    try {
      chmodSync(cfg.socketPath, 0o600);
    } catch {
      // best effort
    }
    startPi();
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`switchyard holder: ${err.stack ?? err.message}\n`);
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    rmSync(cfg.socketPath, { force: true });
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      killRequested = true;
      if (!proc) {
        rmSync(cfg.socketPath, { force: true });
        process.exit(0);
      }
      try {
        proc.kill(sig);
      } catch {
        // ignore
      }
    });
  }
}

function isMain(): boolean {
  if (process.env.SWITCHYARD_HOLDER_CONFIG === undefined || !process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const raw = process.env.SWITCHYARD_HOLDER_CONFIG ?? "";
  delete process.env.SWITCHYARD_HOLDER_CONFIG;
  runHolder(JSON.parse(raw) as HolderConfig);
}
