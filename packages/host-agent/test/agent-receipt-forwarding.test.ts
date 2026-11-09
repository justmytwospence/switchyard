import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  AGENT_FRAME_MAX_BYTES,
  type AgentMethod,
  type AgentRequestFrame,
  type HostAgentRequestFrame,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  AgentBroker,
  type AgentBrokerRequest,
  type AgentBrokerSession,
} from "../src/agent-broker.js";
import { HostDb } from "../src/db/index.js";
import { type AgentRequestOptions, CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";

const FEATURES = ["agentRequests.v1", "policies.v1"];
const REPLAY = { requestHash: "a".repeat(64) };
const CONTEXT = { humanInputId: "human-current", causalMessageId: "message-current" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, "listening");
  const frames: HostAgentRequestFrame[] = [];
  let response: unknown = { found: true, ...REPLAY };
  let error: { code: string; message: string } | undefined;
  server.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "hello") {
        ws.send(
          JSON.stringify({
            type: "welcome",
            coordinatorVersion: "test",
            ackedHostSeq: 0,
            features: FEATURES,
          }),
        );
      } else if (frame.type === "agent.request") {
        frames.push(frame);
        const result =
          frame.method === "session.bind"
            ? {
                version: 1,
                sessionId: frame.sessionId,
                nativeSessionId: frame.nativeSessionId,
                runtimeId: frame.runtimeId,
                features: FEATURES,
                policyRequired: true,
                sessionUrl: "https://switchyard.example/code/session-current",
              }
            : response;
        ws.send(
          JSON.stringify({
            type: "agent.result",
            requestId: frame.requestId,
            runtimeId: frame.runtimeId,
            ...(error ? { ok: false, error } : { ok: true, result }),
          }),
        );
      }
    });
  });
  const link = new CoordinatorLink({
    db,
    coordinatorUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hostId: "host-current",
    credential: "test",
    hello: () => ({
      name: "test",
      agentVersion: "test",
      piVersion: null,
      piCompatible: false,
      platform: "darwin",
      capabilities: null,
      protocolVersion: 1,
    }),
    onCommand: vi.fn(),
    log: silentLogger(),
  });
  cleanup.push(() => link.stop());
  const welcome = once(link.events, "welcome");
  link.start();
  await welcome;
  const session: AgentBrokerSession = {
    sessionId: "session-current",
    mode: "rpc",
    policyRequired: true,
    getPolicyBoundary: vi.fn(async () => ({
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      cwdReal: "/workspace",
      workspaceRootReal: "/workspace",
    })),
    getToolPolicyContext: vi.fn(),
    configureAgent: vi.fn(async () => ({
      configured: true,
      agentTools: true,
      messageDelivery: true,
      policyRequired: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    })),
    bridgeRequest: vi.fn(async () => undefined),
    replyAgent: vi.fn(),
    setPolicyWaiting: vi.fn(),
  };
  const broker = new AgentBroker({ link });
  cleanup.push(() => broker.close());
  const handle = broker.attach(session);
  const hello = {
    type: "agent.hello",
    version: 1,
    runtimeId: "runtime-current",
    nativeSessionId: "native-current",
    sessionFile: null,
    pid: 123,
    mode: "rpc",
    capabilities: {
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    },
    context: CONTEXT,
  };
  await handle.hello(hello);
  frames.length = 0;
  const frame = (changes: Partial<AgentBrokerRequest> = {}): AgentBrokerRequest => ({
    type: "agent.request",
    requestId: randomUUID(),
    sessionId: session.sessionId,
    nativeSessionId: hello.nativeSessionId,
    runtimeId: hello.runtimeId,
    bindingId: handle.snapshot().configuration!.bindingId,
    context: { ...CONTEXT },
    toolCallId: "tool-current",
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    method: "receipt.peek",
    args: { method: "task.create", args: { objective: "Original task" } },
    ...changes,
  });
  const direct = (
    method: AgentMethod,
    args: unknown,
    options: AgentRequestOptions = { toolCallId: "tool-current" },
  ) =>
    link.requestAgent(
      session.sessionId,
      hello.nativeSessionId,
      hello.runtimeId,
      method,
      args,
      options,
    );
  return {
    broker,
    handle,
    hello,
    session,
    link,
    frames,
    frame,
    direct,
    respond(result: unknown) {
      response = result;
    },
    fail(next: NonNullable<typeof error>) {
      error = next;
    },
  };
}

describe("D.9 host receipt forwarding", () => {
  it("forwards hidden peek with the current owner/tool/binding, exact args, trusted context and deadline", async () => {
    const f = await fixture();
    const request = f.frame();
    await f.handle.request(request);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toEqual({
      type: "agent.request",
      requestId: expect.any(String),
      sessionId: request.sessionId,
      nativeSessionId: request.nativeSessionId,
      runtimeId: request.runtimeId,
      toolCallId: request.toolCallId,
      context: CONTEXT,
      deadlineAt: request.deadlineAt,
      method: "receipt.peek",
      args: request.args,
    });
    expect(f.frames[0].requestId).not.toBe(request.requestId);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result: { found: true, ...REPLAY },
    });
    expect(f.session.getToolPolicyContext).not.toHaveBeenCalled();
    expect(f.session.setPolicyWaiting).not.toHaveBeenCalled();
    expect(f.link.pending()).toEqual([]);
  });

  it.each(["task.create", "message.send", "inbox.read"] as const)(
    "preserves the replay-only restriction unchanged on %s",
    async (method) => {
      const f = await fixture();
      const args = { original: "unchanged", context: { humanInputId: "not-trusted" } };
      f.respond({ originalResult: true });
      await f.handle.request(f.frame({ method, args, receiptReplay: REPLAY }));
      expect(f.frames).toHaveLength(1);
      expect(f.frames[0]).toMatchObject({ method, args, receiptReplay: REPLAY, context: CONTEXT });
      expect(f.frames[0]).not.toHaveProperty("policyContext");
      expect(f.session.replyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({ ok: true, result: { originalResult: true } }),
      );
    },
  );

  it.each([
    { sessionId: "another-session" },
    { nativeSessionId: "another-native" },
    { runtimeId: "another-runtime" },
    { bindingId: "obsolete-binding" },
    { toolCallId: undefined },
  ])("rejects peek identity substitution or missing tool identity: %j", async (change) => {
    const f = await fixture();
    await f.handle.request(f.frame(change));
    expect(f.frames).toEqual([]);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
  });

  it("requires the new controller binding after reattachment and rejects an old owning handle", async () => {
    const f = await fixture();
    const oldFrame = f.frame();
    await f.handle.hello({ ...f.hello, runtimeId: "runtime-new" });
    f.frames.length = 0;
    await f.handle.request(oldFrame);
    expect(f.frames).toEqual([]);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "stale_control" }),
      }),
    );
    await f.handle.request(f.frame({ runtimeId: "runtime-new" }));
    expect(f.frames).toHaveLength(1);
    const oldHandle = f.handle;
    f.broker.attach(f.session);
    f.frames.length = 0;
    await oldHandle.request(oldFrame);
    expect(f.frames).toEqual([]);
  });

  it.each([
    "session.bind",
    "receipt.peek",
    "policy.evaluate",
    "policy.status",
    "policy.cancel",
  ] as const)(
    "rejects receiptReplay on %s rather than stripping it locally or on the host wire",
    async (method) => {
      const f = await fixture();
      const request = f.frame({ method, receiptReplay: REPLAY });
      await f.handle.request(request);
      expect(f.frames).toEqual([]);
      expect(f.session.replyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "invalid_request" }),
        }),
      );
      await expect(
        f.direct(method, request.args, { toolCallId: "tool-current", receiptReplay: REPLAY }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.frames).toEqual([]);
    },
  );

  it.each([
    { receiptReplay: { requestHash: "invalid" } },
    { receiptReplay: { ...REPLAY, allow: true } },
    { policyContext: { toolCallId: "spoofed" } },
    { controllerEpoch: "spoofed" },
    { context: { ...CONTEXT, hostId: "spoofed" } },
  ])(
    "rejects malformed replay and untrusted extra metadata without normal execution: %j",
    async (change) => {
      const f = await fixture();
      await f.handle.request({
        ...f.frame({ method: "task.create", receiptReplay: REPLAY }),
        ...change,
      });
      expect(f.frames).toEqual([]);
      expect(f.session.replyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "invalid_request" }),
        }),
      );
    },
  );

  it("requires toolCallId on direct peek and inbox replay, rejects malformed peek args", async () => {
    const f = await fixture();
    for (const args of [
      { method: "task.create", args: {}, sessionId: "other" },
      { method: "bash", args: {} },
    ]) {
      await expect(f.direct("receipt.peek", args)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(f.direct("receipt.peek", f.frame().args, {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(f.direct("inbox.read", {}, { receiptReplay: REPLAY })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await f.handle.request(
      f.frame({ method: "inbox.read", args: {}, receiptReplay: REPLAY, toolCallId: undefined }),
    );
    expect(f.frames).toEqual([]);
  });

  it("never retries a missing receipt as a normal mutation and preserves the stored error", async () => {
    const f = await fixture();
    const error = {
      code: "conflict",
      message: "The recorded tool result is no longer available; no action was executed.",
    };
    f.fail(error);
    await f.handle.request(
      f.frame({
        method: "task.create",
        args: { objective: "Original task" },
        receiptReplay: REPLAY,
      }),
    );
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0].receiptReplay).toEqual(REPLAY);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error }),
    );
    expect(f.session.getToolPolicyContext).not.toHaveBeenCalled();
    expect(f.session.setPolicyWaiting).not.toHaveBeenCalled();
  });

  it("rejects expired deadlines and oversized UTF-8 local frames without dropping a healthy link", async () => {
    const f = await fixture();
    await f.handle.request(f.frame({ deadlineAt: new Date(Date.now() - 1000).toISOString() }));
    await f.handle.request(
      f.frame({ args: { method: "inbox.read", args: { text: "é".repeat(70_000) } } }),
    );
    expect(f.frames).toEqual([]);
    expect(f.link.connected).toBe(true);
    await f.handle.request(f.frame());
    expect(f.frames).toHaveLength(1);
  });

  it("counts the replay marker in the enriched 128-KiB host frame limit", async () => {
    const f = await fixture();
    const options = {
      toolCallId: "tool-current",
      deadlineAt: f.frame().deadlineAt,
      context: CONTEXT,
    };
    await f.direct("inbox.read", { pad: "" }, options);
    const base: AgentRequestFrame = f.frames[0];
    const args = {
      pad: "x".repeat(AGENT_FRAME_MAX_BYTES - Buffer.byteLength(JSON.stringify(base))),
    };
    await f.direct("inbox.read", args, options);
    expect(Buffer.byteLength(JSON.stringify(f.frames[1]))).toBe(AGENT_FRAME_MAX_BYTES);
    await expect(
      f.direct("inbox.read", args, { ...options, receiptReplay: REPLAY }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.frames).toHaveLength(2);
    expect(f.link.connected).toBe(true);
  });
});
