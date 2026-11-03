import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import switchyardTerminal, { sessionTotals } from "../src/bridge/switchyard-terminal.js";

interface Holder {
  server: Server;
  path: string;
  lines: any[];
  socket: () => Socket;
  send(obj: object): void;
}

let dir: string;
let holder: Holder;

async function startHolder(): Promise<Holder> {
  const path = join(dir, "c.sock");
  const lines: any[] = [];
  let sock: Socket | null = null;
  const server = createServer((s) => {
    sock = s;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    server,
    path,
    lines,
    socket: () => sock!,
    send: (obj) => sock!.write(`${JSON.stringify(obj)}\n`),
  };
}

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
    handlers,
    on: (name: string, fn: (e: any, c: any) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    emit(name: string, event: any, ctx: any) {
      for (const fn of handlers.get(name) ?? []) fn({ type: name, ...event }, ctx);
    },
    sendUserMessage: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: () => "named",
  };
}

function fakeCtx(ui: any, overrides: Record<string, unknown> = {}) {
  let idle = true;
  return {
    ui,
    setIdle: (v: boolean) => {
      idle = v;
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: vi.fn(),
    shutdown: vi.fn(),
    sessionManager: {
      getSessionId: () => "nat-1",
      getSessionFile: () => "/tmp/nat-1.jsonl",
      getEntries: () => [],
    },
    ...overrides,
  };
}

/** A terminal ui whose dialogs resolve when the test says so (or default on abort). */
function fakeUi() {
  const calls: { method: string; args: any[]; resolve: (v: unknown) => void }[] = [];
  const dialog =
    (method: string, dflt: unknown) =>
    (...args: any[]) =>
      new Promise((resolve) => {
        const opts = method === "editor" ? undefined : args[2];
        opts?.signal?.addEventListener("abort", () => resolve(dflt));
        calls.push({ method, args, resolve });
      });
  return {
    calls,
    ui: {
      select: dialog("select", undefined),
      confirm: dialog("confirm", false),
      input: dialog("input", undefined),
      editor: dialog("editor", undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setTitle: vi.fn(),
    } as Record<string, any>,
  };
}

async function load(ui: any, ctxOverrides: Record<string, unknown> = {}) {
  const pi = fakePi();
  switchyardTerminal(pi);
  await until(() => holder.lines.some((l) => l.role === "extension"));
  const ctx = fakeCtx(ui, ctxOverrides);
  pi.emit("session_start", { reason: "startup" }, ctx);
  await until(() => holder.lines.some((l) => l.type === "extension_hello"));
  return { pi, ctx };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sy-ext-"));
  holder = await startHolder();
  process.env.SWITCHYARD_CONTROL_SOCKET = holder.path;
});

afterEach(() => {
  delete process.env.SWITCHYARD_CONTROL_SOCKET;
  holder.socket()?.destroy();
  holder.server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("switchyard terminal extension", () => {
  it("does nothing without a control socket", () => {
    delete process.env.SWITCHYARD_CONTROL_SOCKET;
    const pi = fakePi();
    switchyardTerminal(pi);
    expect(pi.handlers.size).toBe(0);
  });

  it("lets a remote answer win a select and closes the terminal dialog", async () => {
    const { ui, calls } = fakeUi();
    await load(ui);
    expect(holder.lines.find((l) => l.type === "extension_hello").remoteDialogs).toBe(true);
    const result = ui.select("Pick", ["A", "B"]);
    await until(() => holder.lines.some((l) => l.type === "extension_ui_request"));
    const req = holder.lines.find((l) => l.type === "extension_ui_request");
    expect(req).toMatchObject({ method: "select", title: "Pick", options: ["A", "B"] });
    await until(() => calls.length === 1);
    holder.send({ type: "extension_ui_response", id: req.id, value: "B" });
    expect(await result).toBe("B");
    expect(calls[0]!.args[2].signal.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(holder.lines.some((l) => l.type === "extension_ui_closed")).toBe(false);
  });

  it("reports a dialog answered in the terminal", async () => {
    const { ui, calls } = fakeUi();
    await load(ui);
    const result = ui.confirm("Sure?", "Really");
    await until(() => calls.length === 1);
    calls[0]!.resolve(true);
    expect(await result).toBe(true);
    await until(() => holder.lines.some((l) => l.type === "extension_ui_closed"));
    expect(holder.lines.find((l) => l.type === "extension_ui_closed")).toMatchObject({
      by: "terminal",
    });
  });

  it("dismisses the terminal editor with Esc when answered remotely", async () => {
    const { ui } = fakeUi();
    await load(ui);
    const result = ui.editor("Write", "pre");
    await until(() => holder.lines.some((l) => l.type === "extension_ui_request"));
    const req = holder.lines.find((l) => l.type === "extension_ui_request");
    expect(req).toMatchObject({ method: "editor", prefill: "pre" });
    holder.send({ type: "extension_ui_response", id: req.id, value: "text" });
    expect(await result).toBe("text");
    await until(() => holder.lines.some((l) => l.type === "holder_keys"));
    expect(holder.lines.find((l) => l.type === "holder_keys").data).toBe("\u001b");
  });

  it("re-sends pending dialogs when a control attaches", async () => {
    const { ui } = fakeUi();
    await load(ui);
    void ui.input("Name?", "type");
    await until(() => holder.lines.filter((l) => l.type === "extension_ui_request").length === 1);
    holder.send({ type: "control_attached" });
    await until(() => holder.lines.filter((l) => l.type === "extension_ui_request").length === 2);
  });

  it("reports no remote dialogs when the ui cannot be patched", async () => {
    const { ui } = fakeUi();
    Object.freeze(ui);
    await load(ui);
    expect(holder.lines.find((l) => l.type === "extension_hello").remoteDialogs).toBe(false);
  });

  it("forwards fire-and-forget ui in RPC shape", async () => {
    const { ui } = fakeUi();
    await load(ui);
    ui.setStatus("k", "v");
    await until(() => holder.lines.some((l) => l.method === "setStatus"));
    expect(holder.lines.find((l) => l.method === "setStatus")).toMatchObject({
      type: "extension_ui_request",
      statusKey: "k",
      statusText: "v",
    });
  });

  it("answers commands: prompt, slash commands, busy prompts, steer, stats", async () => {
    const { ui } = fakeUi();
    const entries = [
      {
        type: "message",
        message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.5 } } },
      },
      {
        type: "message",
        message: { role: "toolResult", usage: { totalTokens: 5, cost: { total: 0.25 } } },
      },
      { type: "message", message: { role: "user" } },
    ];
    const { pi, ctx } = await load(ui, {
      sessionManager: {
        getSessionId: () => "nat-1",
        getSessionFile: () => "/tmp/nat-1.jsonl",
        getEntries: () => entries,
      },
    });
    const reply = async (cmd: object & { id: string }) => {
      holder.send(cmd);
      await until(() => holder.lines.some((l) => l.type === "response" && l.id === cmd.id));
      return holder.lines.find((l) => l.type === "response" && l.id === cmd.id);
    };
    expect(await reply({ type: "prompt", id: "1", message: "hi" })).toMatchObject({
      success: true,
      data: { disposition: "started" },
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("hi");
    expect((await reply({ type: "prompt", id: "2", message: "/cmd" })).success).toBe(false);
    ctx.setIdle(false);
    expect((await reply({ type: "prompt", id: "3", message: "x" })).error).toContain(
      "Session is running",
    );
    expect(await reply({ type: "steer", id: "4", message: "s" })).toMatchObject({
      data: { disposition: "queued" },
    });
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("s", { deliverAs: "steer" });
    await until(() => holder.lines.some((l) => l.type === "queue_update"));
    expect(await reply({ type: "get_session_stats", id: "5" })).toMatchObject({
      data: { tokens: { total: 15 }, cost: 0.75 },
    });
    expect(await reply({ type: "get_state", id: "6" })).toMatchObject({
      data: { sessionId: "nat-1", sessionFile: "/tmp/nat-1.jsonl", isStreaming: true },
    });
    expect((await reply({ type: "nope", id: "7" })).error).toBe("Unknown command: nope");
  });

  it("sums usage like Pi", () => {
    expect(
      sessionTotals([
        { type: "usage", usage: { totalTokens: 1, cost: { total: 1 } } },
        { type: "compaction", usage: { totalTokens: 2, cost: { total: 2 } } },
      ]),
    ).toEqual({ tokens: 3, cost: 3 });
  });
});
