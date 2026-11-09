import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { AgentRequestFrame, HostPolicyBoundary } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  AgentBroker,
  type AgentBrokerHello,
  type AgentBrokerOptions,
  type AgentBrokerRequest,
  type AgentBrokerSession,
} from "../src/agent-broker.js";
import { HostDb } from "../src/db/index.js";
import { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";

const FEATURES = ["agentRequests.v1", "policies.v1"];
const WAIT = {
  type: "policy.required",
  decisionId: "decision1",
  interactionId: "interaction1",
  interactionUrl: "https://switchyard.example/code/session1",
};
const BOUNDARY: HostPolicyBoundary = {
  cwd: "/workspace",
  workspaceRoot: "/workspace",
  cwdReal: "/workspace",
  workspaceRootReal: "/workspace",
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function fixture() {
  let connected = true;
  const events: CoordinatorLink["events"] = new EventEmitter();
  const requestAgent = vi.fn<CoordinatorLink["requestAgent"]>(
    async (sessionId, nativeSessionId, runtimeId, method) =>
      method === "session.bind"
        ? {
            version: 1,
            sessionId,
            nativeSessionId,
            runtimeId,
            features: FEATURES,
            policyRequired: true,
            sessionUrl: WAIT.interactionUrl,
          }
        : {},
  );
  const link = {
    get connected() {
      return connected;
    },
    negotiatedFeatures: new Set(FEATURES),
    events,
    requestAgent,
  } satisfies AgentBrokerOptions["link"];
  const session = {
    sessionId: "session1",
    mode: "rpc" as const,
    policyRequired: true,
    getPolicyBoundary: vi.fn<AgentBrokerSession["getPolicyBoundary"]>(async () => BOUNDARY),
    getToolPolicyContext: vi.fn<AgentBrokerSession["getToolPolicyContext"]>(),
    configureAgent: vi.fn<AgentBrokerSession["configureAgent"]>(async () => ({
      configured: true,
      agentTools: true,
      messageDelivery: true,
      policyRequired: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    })),
    bridgeRequest: vi.fn<AgentBrokerSession["bridgeRequest"]>(async () => ({})),
    replyAgent: vi.fn<AgentBrokerSession["replyAgent"]>(),
    setPolicyWaiting: vi.fn<AgentBrokerSession["setPolicyWaiting"]>(),
  };
  const broker = new AgentBroker({ link });
  cleanup.push(() => broker.close());
  const handle = broker.attach(session);
  const hello: AgentBrokerHello = {
    type: "agent.hello",
    version: 1,
    runtimeId: "runtime1",
    nativeSessionId: "native1",
    sessionFile: null,
    pid: 1,
    mode: "rpc",
    capabilities: {
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    },
    context: { humanInputId: "human1", causalMessageId: null },
  };
  await handle.hello(hello);
  const frame = (overrides: Partial<AgentBrokerRequest> = {}): AgentBrokerRequest => ({
    type: "agent.request",
    requestId: randomUUID(),
    sessionId: session.sessionId,
    runtimeId: hello.runtimeId,
    nativeSessionId: hello.nativeSessionId,
    bindingId: handle.snapshot().configuration!.bindingId,
    method: "task.create",
    args: { objective: "Approved work" },
    context: hello.context,
    toolCallId: "tool1",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  });
  const ask = async () => {
    requestAgent.mockResolvedValueOnce(WAIT);
    await handle.request(frame());
  };
  return {
    link,
    session,
    handle,
    hello,
    frame,
    ask,
    disconnect() {
      connected = false;
      events.emit("disconnected", { code: 1006, reason: "test" });
    },
  };
}

describe("D.5 broker resumable request approval", () => {
  it.each(["task.create", "message.send", "inbox.read"] as const)(
    "recognizes %s policy.required on the direct result lane without replaying the tool",
    async (method) => {
      const f = await fixture();
      f.link.requestAgent.mockResolvedValueOnce(WAIT);
      const request = f.frame({ method });
      await f.handle.request(request);
      expect(f.session.setPolicyWaiting).toHaveBeenCalledExactlyOnceWith("decision1", true);
      expect(f.session.replyAgent).toHaveBeenCalledExactlyOnceWith({
        type: "agent.result",
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        bindingId: request.bindingId,
        ok: true,
        result: WAIT,
      });
      expect(f.link.requestAgent.mock.calls.map((call) => call[3])).toEqual([
        "session.bind",
        method,
      ]);
      expect(f.session.getToolPolicyContext).not.toHaveBeenCalled();
    },
  );

  it("deduplicates repeated ASK and keeps waiting across healthy long polls longer than 30 seconds", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.ask();
    await f.ask();
    for (let i = 0; i < 3; i++) {
      const pending = deferred<unknown>();
      f.link.requestAgent.mockReturnValueOnce(pending.promise);
      const poll = f.handle.request(
        f.frame({ method: "policy.status", args: { decisionId: "decision1", waitMs: 25_000 } }),
      );
      await vi.advanceTimersByTimeAsync(25_000);
      pending.resolve({ state: "pending" });
      await poll;
    }
    expect(f.session.setPolicyWaiting.mock.calls).toEqual([["decision1", true]]);
    f.link.requestAgent.mockResolvedValueOnce({ state: "allowed" });
    await f.handle.request(
      f.frame({ method: "policy.status", args: { decisionId: "decision1", waitMs: 25_000 } }),
    );
    expect(f.session.setPolicyWaiting.mock.calls).toEqual([
      ["decision1", true],
      ["decision1", false],
    ]);
    // An ALLOW status never implicitly resumes an original tool request in the host.
    expect(f.link.requestAgent.mock.calls.filter((call) => call[3] === "task.create")).toHaveLength(
      2,
    );
  });

  it("expires an abandoned wait with an independent one-second cancellation", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.ask();
    f.link.requestAgent.mockReturnValueOnce(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("decision1", false);
    const cancel = f.link.requestAgent.mock.calls.at(-1)!;
    expect(cancel[3]).toBe("policy.cancel");
    expect(cancel[4]).toEqual({ decisionId: "decision1" });
    expect(cancel[5]).toMatchObject({ timeoutMs: 1000 });
    expect(cancel[5]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel[5]?.signal?.aborted).toBe(true);
    expect(f.session.replyAgent).toHaveBeenCalledOnce();
  });

  it("cancel interrupts an in-flight status and never delivers its late approval", async () => {
    const f = await fixture();
    await f.ask();
    const late = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(late.promise);
    const poll = f.handle.request(
      f.frame({ method: "policy.status", args: { decisionId: "decision1" } }),
    );
    const signal = f.link.requestAgent.mock.calls.at(-1)![5]!.signal!;
    await f.handle.request(f.frame({ method: "policy.cancel", args: { decisionId: "decision1" } }));
    await poll;
    expect(signal.aborted).toBe(true);
    const count = f.session.replyAgent.mock.calls.length;
    late.resolve({ state: "allowed" });
    await flush();
    expect(f.session.replyAgent).toHaveBeenCalledTimes(count);
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("decision1", false);
  });

  it.each(["disconnect", "lost", "close", "native", "binding"] as const)(
    "fences pending results and clears request waiting on %s",
    async (loss) => {
      const f = await fixture();
      await f.ask();
      const late = deferred<unknown>();
      f.link.requestAgent.mockReturnValueOnce(late.promise);
      const poll = f.handle.request(
        f.frame({ method: "policy.status", args: { decisionId: "decision1" } }),
      );
      const signal = f.link.requestAgent.mock.calls.at(-1)![5]!.signal!;
      if (loss === "disconnect") f.disconnect();
      else if (loss === "native") await f.handle.hello({ ...f.hello, nativeSessionId: "native2" });
      else if (loss === "binding") await f.handle.hello(f.hello);
      else f.handle[loss]();
      await poll;
      expect(signal.aborted).toBe(true);
      expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("decision1", false);
      const count = f.session.replyAgent.mock.calls.length;
      late.resolve({ state: "pending" });
      await flush();
      expect(f.session.replyAgent).toHaveBeenCalledTimes(count);
      expect(f.link.requestAgent.mock.calls.some((call) => call[3] === "policy.cancel")).toBe(true);
    },
  );

  it("old-generation finally cannot clear a new binding's same decision", async () => {
    const f = await fixture();
    await f.ask();
    f.link.requestAgent.mockReturnValueOnce(new Promise(() => {}));
    const oldPoll = f.handle.request(
      f.frame({ method: "policy.status", args: { decisionId: "decision1" } }),
    );
    await f.handle.hello(f.hello);
    await f.ask();
    await oldPoll;
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("decision1", true);
  });

  it("rejects malformed wait envelopes without marking a tool complete or waiting", async () => {
    const f = await fixture();
    f.link.requestAgent.mockResolvedValueOnce({ ...WAIT, unexpected: true });
    await f.handle.request(f.frame());
    expect(f.session.setPolicyWaiting).not.toHaveBeenCalled();
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_request" }),
      }),
    );
  });
});

describe("D.5 broker fixed request deadline", () => {
  it("retains a retry's deadline, but permits a fresh explicit request after approval", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const first = f.frame({ deadlineAt: new Date(Date.now() + 5000).toISOString() });
    await f.handle.request(first);
    await vi.advanceTimersByTimeAsync(2000);
    await f.handle.request({ ...first, requestId: randomUUID() });
    const calls = f.link.requestAgent.mock.calls.filter((call) => call[3] === "task.create");
    expect(calls.map((call) => call[5]?.deadlineAt)).toEqual([first.deadlineAt, first.deadlineAt]);
    expect(calls[1][5]?.timeoutMs).toBe(3000);
    const resumed = f.frame();
    await f.handle.request(resumed);
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.deadlineAt).toBe(resumed.deadlineAt);
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.toolCallId).toBe(first.toolCallId);
  });

  it("caps distant deadlines and stops expired requests before forwarding", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const now = Date.now();
    await f.handle.request(f.frame({ deadlineAt: new Date(now + 120_000).toISOString() }));
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.deadlineAt).toBe(
      new Date(now + 30_000).toISOString(),
    );
    const count = f.link.requestAgent.mock.calls.length;
    await f.handle.request(f.frame({ deadlineAt: new Date(now - 1).toISOString() }));
    expect(f.link.requestAgent).toHaveBeenCalledTimes(count);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "timeout" }) }),
    );
  });

  it("aborts at the supplied deadline and ignores a late policy wait result", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const late = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(late.promise);
    const request = f.handle.request(
      f.frame({ deadlineAt: new Date(Date.now() + 100).toISOString() }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await request;
    late.resolve(WAIT);
    await flush();
    expect(f.session.setPolicyWaiting).not.toHaveBeenCalled();
    expect(f.session.replyAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "timeout" }) }),
    );
  });
});

async function linkFixture() {
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const frames: AgentRequestFrame[] = [];
  let peer!: WebSocket;
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "hello")
        ws.send(
          JSON.stringify({
            type: "welcome",
            coordinatorVersion: "test",
            ackedHostSeq: 0,
            features: FEATURES,
          }),
        );
      if (frame.type === "agent.request") {
        frames.push(frame);
        ws.send(
          JSON.stringify({
            type: "agent.result",
            requestId: frame.requestId,
            runtimeId: frame.runtimeId,
            ok: true,
            result: {},
          }),
        );
      }
    });
  });
  const link = new CoordinatorLink({
    db,
    coordinatorUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hostId: "host1",
    credential: "test",
    hello: () => ({
      name: "host",
      agentVersion: "test",
      piVersion: null,
      piCompatible: false,
      platform: "darwin",
      capabilities: null,
      protocolVersion: 1,
    }),
    onCommand: () => {
      throw new Error("Not the command lane");
    },
    log: silentLogger(),
    backoffMs: [1],
  });
  cleanup.push(() => link.stop());
  const welcome = new Promise<void>((resolve) => link.events.once("welcome", () => resolve()));
  link.start();
  await welcome;
  return {
    link,
    frames,
    get peer() {
      return peer;
    },
  };
}

describe("D.5 link deadline propagation", () => {
  it("preserves supplied deadlines across attempts with fresh transport IDs and no outbox", async () => {
    const f = await linkFixture();
    const deadlineAt = new Date(Date.now() + 5000).toISOString();
    for (let i = 0; i < 2; i++)
      await f.link.requestAgent(
        "session1",
        "native1",
        "runtime1",
        "task.create",
        { objective: "Work" },
        { toolCallId: "tool1", deadlineAt },
      );
    expect(f.frames.map((frame) => frame.deadlineAt)).toEqual([deadlineAt, deadlineAt]);
    expect(f.frames[0].requestId).not.toBe(f.frames[1].requestId);
    expect(f.link.pending()).toEqual([]);
  });

  it("shortens to timeoutMs, caps at 30 seconds, and rejects expired deadlines before sending", async () => {
    const f = await linkFixture();
    const now = Date.now();
    await f.link.requestAgent(
      "session1",
      "native1",
      "runtime1",
      "inbox.read",
      {},
      { timeoutMs: 2000, deadlineAt: new Date(now + 60_000).toISOString() },
    );
    expect(Date.parse(f.frames[0].deadlineAt!)).toBeGreaterThanOrEqual(now + 2000);
    expect(Date.parse(f.frames[0].deadlineAt!)).toBeLessThanOrEqual(Date.now() + 2000);
    await f.link.requestAgent(
      "session1",
      "native1",
      "runtime1",
      "inbox.read",
      {},
      { timeoutMs: 120_000 },
    );
    expect(Date.parse(f.frames[1].deadlineAt!)).toBeLessThanOrEqual(Date.now() + 30_000);
    await expect(
      f.link.requestAgent(
        "session1",
        "native1",
        "runtime1",
        "inbox.read",
        {},
        { deadlineAt: new Date(now - 1).toISOString() },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(f.frames).toHaveLength(2);
  });
});
