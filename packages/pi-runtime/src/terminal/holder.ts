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
import { chmodSync, existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface HolderConfig {
  socketPath: string;
  piBin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

const MAX_BUFFER = 20_000;
const MAX_TO_EXTENSION = 1000;
const EXIT_WAIT_MS = 5 * 60_000;

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
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      nl = buf.indexOf("\n");
    }
  });
}

function write(socket: Socket | null, line: string): void {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`${line}\n`);
  } catch {
    // closed meanwhile
  }
}

export function runHolder(cfg: HolderConfig): void {
  ensureSpawnHelper();
  const pty = require("node-pty") as typeof import("node-pty");
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
  let shuttingDown = false;

  const term = new Terminal({
    cols: cfg.cols,
    rows: cfg.rows,
    scrollback: 2000,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer as never);

  const proc = pty.spawn(cfg.piBin, cfg.args, {
    name: "xterm-256color",
    cols: cfg.cols,
    rows: cfg.rows,
    cwd: cfg.cwd,
    env: cfg.env,
  });

  const resize = (cols: number, rows: number) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    if (exitInfo) return;
    try {
      proc.resize(cols, rows);
      term.resize(cols, rows);
    } catch {
      // the pty may be closing
    }
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

  const sendExtension = (line: string) => {
    if (extension && !extension.destroyed) {
      write(extension, line);
      return;
    }
    toExtension.push(line);
    if (toExtension.length > MAX_TO_EXTENSION) toExtension.shift();
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
    setTimeout(() => process.exit(0), 100).unref();
  };

  proc.onData((d: string) => {
    term.write(d);
    if (viewers.size === 0) return;
    const line = JSON.stringify({ t: "out", d: Buffer.from(d, "utf8").toString("base64") });
    for (const v of viewers) write(v, line);
  });

  proc.onExit(({ exitCode, signal }) => {
    exitInfo = { code: exitCode ?? null, signal: signal ? signalName(signal) : null };
    const closed = JSON.stringify({ t: "closed", reason: "Pi exited" });
    for (const v of viewers) {
      write(v, closed);
      v.end();
    }
    viewers.clear();
    if (control && !control.destroyed) {
      write(control, JSON.stringify({ type: "holder_exit", ...exitInfo }));
      setTimeout(shutdown, 1000).unref();
    } else {
      setTimeout(shutdown, EXIT_WAIT_MS).unref();
    }
  });

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
          write(socket, JSON.stringify({ type: "holder_status", piPid: proc.pid }));
          if (gap) {
            write(socket, JSON.stringify({ type: "holder_gap" }));
            gap = false;
          }
          for (const l of buffer.splice(0)) write(socket, l);
          if (exitInfo) {
            write(socket, JSON.stringify({ type: "holder_exit", ...exitInfo }));
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
          resize(Number(hello.cols), Number(hello.rows));
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
          if (!exitInfo && typeof rec.data === "string") proc.write(rec.data);
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
            proc.kill(typeof rec.signal === "string" ? rec.signal : "SIGTERM");
          } catch {
            // already gone
          }
          return;
        }
        sendExtension(line);
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
        if (!exitInfo) proc.write(Buffer.from(msg.d, "base64").toString("utf8"));
      } else if (msg?.t === "resize") {
        resize(Number(msg.cols), Number(msg.rows));
      }
    });
    socket.on("close", () => {
      if (role === "viewer") viewers.delete(socket);
      else if (role === "control" && control === socket) control = null;
      else if (role === "extension" && extension === socket) extension = null;
    });
  });

  server.listen(cfg.socketPath, () => {
    try {
      chmodSync(cfg.socketPath, 0o600);
    } catch {
      // best effort
    }
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`switchyard holder: ${err.stack ?? err.message}\n`);
    try {
      proc.kill();
    } catch {
      // ignore
    }
    rmSync(cfg.socketPath, { force: true });
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
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
