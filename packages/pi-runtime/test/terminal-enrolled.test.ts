import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import switchyardTerminal from "../src/bridge/switchyard-terminal.js";

let dir: string;
let runtime: string;
const saved = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

async function until(pred: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakePi() {
  const handlers = new Map<string, ((e: any, c: any) => void)[]>();
  return {
    on: (name: string, fn: (e: any, c: any) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    emit(name: string, event: any, ctx: any) {
      for (const fn of handlers.get(name) ?? []) fn({ type: name, ...event }, ctx);
    },
    events: { on: vi.fn() },
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    getSessionName: () => null,
    getThinkingLevel: () => "off",
  };
}

function fakeCtx() {
  return {
    cwd: "/tmp/project",
    ui: { select: vi.fn(), confirm: vi.fn(), input: vi.fn(), editor: vi.fn(), notify: vi.fn() },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: vi.fn(),
    shutdown: vi.fn(),
    model: null,
    sessionManager: {
      getSessionId: () => "nat-1",
      getSessionFile: () => "/tmp/nat-1.jsonl",
      getEntries: () => [],
      getLeafId: () => null,
    },
  };
}

function control(path: string) {
  const lines: any[] = [];
  const s: Socket = createConnection(path);
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  s.write(`${JSON.stringify({ role: "control" })}\n`);
  return { lines, s, send: (o: object) => s.write(`${JSON.stringify(o)}\n`) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sy-enr-"));
  runtime = join(dir, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  process.env.SWITCHYARD_ENROLL_STATE_DIR = dir;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/h/sessions/daily/herdr.sock";
  delete process.env.SWITCHYARD_CONTROL_SOCKET;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  for (const k of ["SWITCHYARD_ENROLL_STATE_DIR", "HERDR_ENV", "HERDR_SOCKET_PATH"])
    delete process.env[k];
  Object.defineProperty(process.stdin, "isTTY", { value: saved.stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: saved.stdout, configurable: true });
  rmSync(dir, { recursive: true, force: true });
});

const sockets = () => readdirSync(runtime).filter((f) => /^ext-[0-9a-f]{8}\.sock$/.test(f));

describe("enrolled terminal extension", () => {
  it("listens like a holder, never quits Pi, and cleans up on shutdown", async () => {
    const pi = fakePi();
    switchyardTerminal(pi);
    // No Switchyard tools or policy hooks in a Pi the user started.
    expect(pi.registerTool).not.toHaveBeenCalled();
    const ctx = fakeCtx();
    pi.emit("session_start", { reason: "startup" }, ctx);
    await until(() => sockets().length === 1);
    const path = join(runtime, sockets()[0]!);
    await until(() => existsSync(`${path}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${path}.json`, "utf8"))).toMatchObject({
      pid: process.pid,
      cwd: "/tmp/project",
      client: expect.stringMatching(/^herdr:daily@/),
      sessionId: "nat-1",
      sessionFile: "/tmp/nat-1.jsonl",
    });
    // A second copy in the same process stays out of the way.
    const second = fakePi();
    switchyardTerminal(second);
    second.emit("session_start", { reason: "startup" }, ctx);

    const c = control(path);
    await until(() => c.lines.some((l) => l.type === "extension_hello"));
    expect(c.lines[0]).toEqual({ type: "holder_status", piPid: process.pid });
    await until(() => c.lines.some((l) => l.type === "agent.hello"));
    expect(c.lines.find((l) => l.type === "agent.hello").capabilities).toMatchObject({
      agentTools: false,
      messageDelivery: false,
      toolPolicy: false,
    });
    c.send({ type: "get_state", id: "1" });
    await until(() => c.lines.some((l) => l.id === "1"));
    expect(c.lines.find((l) => l.id === "1")).toMatchObject({
      success: true,
      data: { sessionFile: "/tmp/nat-1.jsonl" },
    });
    c.send({ type: "holder_kill", signal: "SIGTERM" });
    c.send({ type: "shutdown", id: "2" });
    await until(() => c.lines.some((l) => l.id === "2"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect(sockets()).toHaveLength(1);

    pi.emit("session_shutdown", {}, ctx);
    await until(() => c.lines.some((l) => l.type === "holder_exit"));
    expect(c.lines.find((l) => l.type === "holder_exit")).toEqual({
      type: "holder_exit",
      code: 0,
      signal: null,
      screen: [],
    });
    expect(sockets()).toHaveLength(0);
    expect(existsSync(`${path}.json`)).toBe(false);
    c.s.destroy();
  });

  it("replays what happened before the host attached", async () => {
    const pi = fakePi();
    switchyardTerminal(pi);
    const ctx = fakeCtx();
    pi.emit("session_start", { reason: "startup" }, ctx);
    await until(() => sockets().length === 1);
    pi.emit("agent_start", {}, ctx);
    const c = control(join(runtime, sockets()[0]!));
    await until(() => c.lines.some((l) => l.type === "agent_start"));
    pi.emit("session_shutdown", {}, ctx);
    c.s.destroy();
  });

  it("inside a holder, leaves control to the copy the holder loaded", () => {
    process.env.SWITCHYARD_CONTROL_SOCKET = join(dir, "holder.sock");
    process.env.SWITCHYARD_TERMINAL_EXTENSION = join(dir, "other-copy.js");
    writeFileSync(join(dir, "other-copy.js"), "");
    try {
      const pi = fakePi();
      switchyardTerminal(pi);
      // A global shim of another version neither connects nor blocks the holder's copy.
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect((globalThis as any)[Symbol.for("switchyard.terminal.loaded")]).toBeUndefined();
    } finally {
      delete process.env.SWITCHYARD_CONTROL_SOCKET;
      delete process.env.SWITCHYARD_TERMINAL_EXTENSION;
    }
  });

  it("does not enrol without a terminal", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const pi = fakePi();
    switchyardTerminal(pi);
    pi.emit("session_start", { reason: "startup" }, fakeCtx());
    expect(sockets()).toHaveLength(0);
  });
});
