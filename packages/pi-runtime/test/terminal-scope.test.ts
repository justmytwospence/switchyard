// @module-tag slow
import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackSocketDir, shortSocketPath } from "../src/bridge/socket-paths.js";
import { holderScriptPath } from "../src/terminal-process.js";
import { makeRuntimeTerminalScope } from "./terminal-scope.js";

vi.mock("node:child_process", async (original) => {
  const mod = await original<typeof import("node:child_process")>();
  return { ...mod, execFileSync: vi.fn(mod.execFileSync) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
});

const FakeTerminal = {
  async start(opts: { runtimeDir?: string }): Promise<string> {
    return opts.runtimeDir ?? "other";
  },
};

async function serve(
  path: string,
  onLine: (line: string, socket: Socket, server: Server) => void,
): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line, socket, server);
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  return server;
}

function close(server: Server, socket: Socket): void {
  socket.end();
  server.close();
}

const timings = { termMs: 35, exitMs: 100, closeMs: 200, timeoutMs: 500 };
const piPid = 12345;
const holderPid = 12346;
const holderCommand = `${process.execPath} ${holderScriptPath()}`;

function controlledPids(parent = holderPid, command = holderCommand) {
  const live = new Set([piPid, holderPid]);
  let onHolderProbe!: () => void;
  const holderProbed = new Promise<void>((resolve) => {
    onHolderProbe = resolve;
  });
  const ps = vi.mocked(execFileSync);
  ps.mockImplementation((_bin, args) => {
    if (args?.[2] === "ppid=" && args[4] === String(piPid)) return `${parent}\n`;
    if (args?.[2] === "command=" && args[4] === String(holderPid)) return `${command}\n`;
    throw new Error(`Unexpected ps arguments: ${JSON.stringify(args)}`);
  });
  const realKill = process.kill;
  const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== piPid && pid !== holderPid) return realKill(pid, signal);
    if (signal !== 0) throw new Error(`Direct PID signal: ${signal}`);
    if (pid === holderPid) onHolderProbe();
    if (!live.has(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  return { live, holderProbed, ps, probe };
}

function removeOwnedState(scope: ReturnType<typeof makeRuntimeTerminalScope>) {
  rmSync(fallbackSocketDir(scope.runtimeDir), { recursive: true, force: true });
  rmSync(scope.root, { recursive: true, force: true });
}

describe("runtime terminal scope", () => {
  it("waits for the verified holder after child exit and socket removal", async () => {
    const { live, holderProbed, ps, probe } = controlledPids();
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    let lookupsAtTerm = 0;
    const server = await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      if (rec.signal === "SIGTERM") {
        lookupsAtTerm = ps.mock.calls.length;
        live.delete(piPid);
        socket.write('{"type":"holder_exit","code":0,"signal":null}\n');
        close(server, socket);
      }
    });
    const disposal = scope.dispose();
    try {
      await Promise.race([
        holderProbed,
        disposal.then(() => {
          throw new Error("disposal completed before holder exit");
        }),
      ]);
      expect(lookupsAtTerm).toBe(2);
      expect(ps.mock.calls.map(([, args]) => args)).toEqual([
        ["-ww", "-o", "ppid=", "-p", String(piPid)],
        ["-ww", "-o", "command=", "-p", String(holderPid)],
      ]);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(scope.root)).toBe(true);
      expect(live.has(holderPid)).toBe(true);
      live.delete(holderPid);
      await disposal;
      expect(probe).toHaveBeenCalledWith(piPid, 0);
      expect(probe).toHaveBeenCalledWith(holderPid, 0);
      expect(existsSync(scope.root)).toBe(false);
    } finally {
      live.clear();
      await disposal.catch(() => {});
      server.close();
      removeOwnedState(scope);
    }
  });

  it("retains diagnostics when the verified holder outlives the close deadline", async () => {
    const { live } = controlledPids();
    const scope = makeRuntimeTerminalScope(FakeTerminal, { ...timings, closeMs: 80 });
    const path = shortSocketPath(scope.runtimeDir, "term");
    const server = await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      if (rec.signal) {
        live.delete(piPid);
        socket.write('{"type":"holder_exit","code":0,"signal":null}\n');
        close(server, socket);
      }
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("holder process exit timeout");
      expect(existsSync(path)).toBe(false);
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      server.close();
      removeOwnedState(scope);
    }
  });

  it.each([
    { parent: holderPid, command: `${holderCommand}.old` },
    { parent: 1, command: holderCommand },
  ])("does not adopt an unexpected parent (PID $parent)", async ({ parent, command }) => {
    const { probe } = controlledPids(parent, command);
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    const signals: string[] = [];
    const server = await serve(path, (line, socket) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      if (rec.signal) signals.push(rec.signal);
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("is not the expected holder");
      expect(signals).toEqual([]);
      expect(probe).not.toHaveBeenCalledWith(parent, 0);
      expect(existsSync(path)).toBe(true);
    } finally {
      server.close();
      removeOwnedState(scope);
    }
  });

  it("does not look up an already exited Pi's parent", async () => {
    const { live, ps, probe } = controlledPids();
    live.delete(piPid);
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    writeFileSync(`${path}.exit.json`, JSON.stringify({ code: 0, signal: null }));
    const signals: string[] = [];
    const server = await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) {
        socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
        close(server, socket);
      }
      if (rec.signal) signals.push(rec.signal);
    });
    try {
      await scope.dispose();
      expect(ps).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalledWith(holderPid, 0);
      expect(signals).toEqual([]);
    } finally {
      server.close();
      removeOwnedState(scope);
    }
  });

  it("waits for a tracked holder whose attached stop removed the socket", async () => {
    const { live, holderProbed, ps } = controlledPids();
    const terminal = {
      async start(opts: { runtimeDir: string }) {
        return { socketPath: shortSocketPath(opts.runtimeDir, "term"), pid: piPid, exited: null };
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    const { socketPath } = await terminal.start({ runtimeDir: scope.runtimeDir });
    let connections = 0;
    const server = await serve(socketPath, () => {});
    server.on("connection", () => connections++);
    let lookupsAtStop = 0;
    scope.onStop(async () => {
      lookupsAtStop = ps.mock.calls.length;
      live.delete(piPid);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const disposal = scope.dispose();
    try {
      await Promise.race([
        holderProbed,
        disposal.then(() => {
          throw new Error("disposal completed before the attached holder exited");
        }),
      ]);
      expect(lookupsAtStop).toBe(2);
      expect(connections).toBe(0); // Capturing the identity did not take the attached control role.
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(scope.root)).toBe(true);
      live.delete(holderPid);
      await disposal;
      expect(existsSync(scope.root)).toBe(false);
    } finally {
      live.clear();
      await disposal.catch(() => {});
      server.close();
      removeOwnedState(scope);
    }
  });
  it("detaches tracked live transports after attached stops before reclaiming control", async () => {
    const events: string[] = [];
    const terminal = {
      async start(opts: { runtimeDir: string }) {
        return {
          socketPath: shortSocketPath(opts.runtimeDir, "term"),
          pid: undefined,
          exited: null,
          detach: () => events.push("detach"),
        };
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    const { socketPath } = await terminal.start({ runtimeDir: scope.runtimeDir });
    const server = await serve(socketPath, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) {
        events.push("control");
        socket.write('{"type":"holder_status","piPid":null}\n');
      }
      if (rec.signal) {
        socket.write('{"type":"holder_exit","code":0,"signal":null}\n');
        close(server, socket);
      }
    });
    scope.onStop(async () => {
      events.push("attached stop");
    });
    try {
      await scope.dispose();
      expect(events).toEqual(["attached stop", "detach", "control"]);
    } finally {
      server.close();
      removeOwnedState(scope);
    }
  });

  it("retries a failed stop during the final socket scan while retaining the failure", async () => {
    const { live } = controlledPids();
    const terminal = {
      async start(opts: { runtimeDir: string }) {
        return { socketPath: shortSocketPath(opts.runtimeDir, "term"), pid: piPid, exited: null };
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    const { socketPath } = await terminal.start({ runtimeDir: scope.runtimeDir });
    let connections = 0;
    const server = await serve(socketPath, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role && ++connections === 1) socket.write("invalid\n");
      else if (rec.role) socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      if (rec.signal) {
        live.clear();
        socket.write('{"type":"holder_exit","code":0,"signal":null}\n');
        close(server, socket);
      }
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("malformed");
      expect(connections).toBe(2);
      expect(existsSync(scope.root)).toBe(true);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      live.clear();
      server.close();
      removeOwnedState(scope);
    }
  });

  it("does not send signals when a known Pi has already disappeared", async () => {
    const { live } = controlledPids();
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    const signals: string[] = [];
    const server = await serve(path, (line, socket) => {
      const rec = JSON.parse(line);
      if (rec.role) {
        live.delete(piPid);
        socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      }
      if (rec.signal) signals.push(rec.signal);
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("child exit evidence timeout");
      expect(signals).toEqual([]);
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      live.clear();
      server.close();
      removeOwnedState(scope);
    }
  });

  it("does not escalate after the known Pi disappears", async () => {
    const { live } = controlledPids();
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    const signals: string[] = [];
    const server = await serve(path, (line, socket) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write(`${JSON.stringify({ type: "holder_status", piPid })}\n`);
      if (rec.signal) {
        signals.push(rec.signal);
        live.delete(piPid);
      }
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("child exit timeout");
      expect(signals).toEqual(["SIGTERM"]);
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      live.clear();
      server.close();
      removeOwnedState(scope);
    }
  });

  it("verifies exit and socket closure", async () => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write('{"type":"holder_status","piPid":null}\n');
      if (rec.signal === "SIGTERM") {
        socket.write('{"type":"holder_exit","code":0,"signal":null}\n');
        close(server, socket);
      }
    });
    await scope.dispose();
    expect(existsSync(scope.root)).toBe(false);
  });

  it("accepts a persisted exit record before socket closure", async () => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write('{"type":"holder_status","piPid":null}\n');
      if (rec.signal === "SIGTERM") {
        writeFileSync(`${path}.exit.json`, JSON.stringify({ code: 0, signal: null }));
        close(server, socket);
      }
    });
    await scope.dispose();
    expect(existsSync(scope.root)).toBe(false);
  });

  it("escalates TERM to KILL before accepting exit", async () => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    const signals: string[] = [];
    await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write('{"type":"holder_status","piPid":null}\n');
      if (rec.signal) signals.push(rec.signal);
      if (rec.signal === "SIGKILL") {
        socket.write('{"type":"holder_exit","code":null,"signal":"SIGKILL"}\n');
        close(server, socket);
      }
    });
    await scope.dispose();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects closure without exit evidence", async () => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    await serve(path, (line, socket, server) => {
      const rec = JSON.parse(line);
      if (rec.role) socket.write('{"type":"holder_status","piPid":null}\n');
      if (rec.signal) close(server, socket);
    });
    try {
      await expect(scope.dispose()).rejects.toThrow("without child exit evidence");
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      rmSync(scope.root, { recursive: true, force: true });
      rmSync(path, { force: true });
    }
  });

  it("removes unreachable stale sockets", async () => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    writeFileSync(path, "stale");
    await scope.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it.each(["malformed", "timeout"])("retains diagnostics on %s", async (failure) => {
    const scope = makeRuntimeTerminalScope(FakeTerminal, timings);
    const path = shortSocketPath(scope.runtimeDir, "term");
    let peer: Socket | undefined;
    const server = await serve(path, (_line, socket) => {
      peer = socket;
      if (failure === "malformed") socket.write("not json\n");
    });
    try {
      await expect(scope.dispose()).rejects.toThrow(
        failure === "malformed" ? "malformed" : "timeout",
      );
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      peer?.destroy();
      server.close();
      rmSync(scope.root, { recursive: true, force: true });
      rmSync(path, { force: true });
    }
  });

  it("waits for an owned start and unregisters after rejected disposal", async () => {
    let release!: () => void;
    const terminal = {
      start: async (_opts: { runtimeDir?: string }) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const original = terminal.start;
    const scope = makeRuntimeTerminalScope(terminal, { ...timings, timeoutMs: 25 });
    const start = terminal.start({ runtimeDir: scope.runtimeDir });
    const disposal = scope.dispose();
    try {
      await expect(disposal).rejects.toThrow("pending launches");
      expect(scope.dispose()).toBe(disposal);
      expect(terminal.start).toBe(original);
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      release();
      await start;
      rmSync(scope.root, { recursive: true, force: true });
    }
  });

  it("waits for the exact holder after cancellation rejects a spawned start", async () => {
    const child = new EventEmitter() as ChildProcess;
    const terminal = {
      async start(opts: {
        runtimeDir: string;
        onHolderSpawn?: (child: ChildProcess, path: string) => void;
      }) {
        opts.onHolderSpawn?.(child, shortSocketPath(opts.runtimeDir, "term"));
        throw new Error("start canceled");
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    const observer = vi.fn();
    await expect(
      terminal.start({ runtimeDir: scope.runtimeDir, onHolderSpawn: observer }),
    ).rejects.toThrow("start canceled");
    expect(observer).toHaveBeenCalledOnce();
    const disposal = scope.dispose();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(scope.root)).toBe(true);
      child.emit("exit", 0, null);
      await disposal;
      expect(existsSync(scope.root)).toBe(false);
    } finally {
      child.emit("exit", null, "SIGTERM");
      await disposal.catch(() => {});
      removeOwnedState(scope);
    }
  });

  it.each([0, 1])("rejects abnormal holder exit without Pi evidence (case %i)", async (kind) => {
    const child = new EventEmitter() as ChildProcess;
    const terminal = {
      async start(opts: {
        runtimeDir: string;
        onHolderSpawn?: (child: ChildProcess, path: string) => void;
      }) {
        opts.onHolderSpawn?.(child, shortSocketPath(opts.runtimeDir, "term"));
        throw new Error("start canceled");
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    try {
      await expect(terminal.start({ runtimeDir: scope.runtimeDir })).rejects.toThrow("canceled");
      child.emit("exit", kind === 0 ? 1 : null, kind === 0 ? null : "SIGTERM");
      await expect(scope.dispose()).rejects.toThrow("holder child exited abnormally");
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      removeOwnedState(scope);
    }
  });

  it("accepts an abnormal holder exit only with positive Pi exit evidence", async () => {
    const child = new EventEmitter() as ChildProcess;
    const terminal = {
      async start(opts: {
        runtimeDir: string;
        onHolderSpawn?: (child: ChildProcess, path: string) => void;
      }) {
        const path = shortSocketPath(opts.runtimeDir, "term");
        opts.onHolderSpawn?.(child, path);
        writeFileSync(`${path}.exit.json`, JSON.stringify({ code: 0, signal: null }));
        throw new Error("start canceled");
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    try {
      await expect(terminal.start({ runtimeDir: scope.runtimeDir })).rejects.toThrow("canceled");
      child.emit("exit", null, "SIGTERM");
      await scope.dispose();
      expect(existsSync(scope.root)).toBe(false);
    } finally {
      removeOwnedState(scope);
    }
  });

  it("retains the root when an observed holder never exits", async () => {
    const child = new EventEmitter() as ChildProcess;
    const terminal = {
      async start(opts: {
        runtimeDir: string;
        onHolderSpawn?: (child: ChildProcess, path: string) => void;
      }) {
        opts.onHolderSpawn?.(child, shortSocketPath(opts.runtimeDir, "term"));
        throw new Error("start canceled");
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, { ...timings, closeMs: 30 });
    try {
      await expect(terminal.start({ runtimeDir: scope.runtimeDir })).rejects.toThrow("canceled");
      await expect(scope.dispose()).rejects.toThrow("holder child exit timeout");
      expect(existsSync(scope.root)).toBe(true);
    } finally {
      child.emit("exit", null, "SIGTERM");
      removeOwnedState(scope);
    }
  });

  it("waits for the exact holder when Pi exited before disposal", async () => {
    const child = new EventEmitter() as ChildProcess;
    const terminal = {
      async start(opts: {
        runtimeDir: string;
        onHolderSpawn?: (child: ChildProcess, path: string) => void;
      }) {
        const socketPath = shortSocketPath(opts.runtimeDir, "term");
        opts.onHolderSpawn?.(child, socketPath);
        return { socketPath, pid: undefined, exited: { code: 0 } };
      },
    };
    const scope = makeRuntimeTerminalScope(terminal, timings);
    const { socketPath } = await terminal.start({ runtimeDir: scope.runtimeDir });
    writeFileSync(`${socketPath}.exit.json`, JSON.stringify({ code: 0, signal: null }));
    const server = await serve(socketPath, (line, socket, server) => {
      if (JSON.parse(line).role) {
        socket.write('{"type":"holder_status","piPid":null}\n');
        close(server, socket);
      }
    });
    const disposal = scope.dispose();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(scope.root)).toBe(true);
      child.emit("exit", 0, null);
      await disposal;
      expect(existsSync(scope.root)).toBe(false);
    } finally {
      child.emit("exit", 0, null);
      await disposal.catch(() => {});
      server.close();
      removeOwnedState(scope);
    }
  });

  it("tracks only matching classes and runtimes and restores the method", async () => {
    const original = FakeTerminal.start;
    const first = makeRuntimeTerminalScope(FakeTerminal, timings);
    const second = makeRuntimeTerminalScope(FakeTerminal, timings);
    expect(FakeTerminal.start).not.toBe(original);
    expect(await FakeTerminal.start({ runtimeDir: first.runtimeDir })).toBe(first.runtimeDir);
    expect(await FakeTerminal.start({ runtimeDir: "/unrelated" })).toBe("/unrelated");
    await first.dispose();
    expect(FakeTerminal.start).not.toBe(original);
    await second.dispose();
    expect(FakeTerminal.start).toBe(original);
  });
});
