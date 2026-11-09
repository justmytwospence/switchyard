import { AgentToolPolicyWait } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { registerAgentTools } from "../src/bridge/agent-tools.js";
import { installPolicyHooks } from "../src/bridge/policy.js";
import { BridgeAgentRequest } from "../src/bridge-wire.js";

const channels: ReturnType<typeof createAgentChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const sent: any[] = [];
  const tools: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let native = "native";
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => native, getBranch: () => [] },
  };
  const channel = createAgentChannel({
    send: (record) => {
      sent.push(record);
      return true;
    },
    getContext: () => ctx,
    appendEntry: vi.fn(),
    mode: "terminal",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    }),
    policyRequired: true,
  });
  channels.push(channel);
  installPolicyHooks({ on: (name: string, handler: any) => handlers.set(name, handler) }, channel);
  registerAgentTools({ registerTool: (tool: any) => tools.push(tool) }, channel);
  channel.onConnect();
  let bindingId = "binding";
  const command = (method: string, args: unknown) =>
    channel.receive({
      type: "bridge.command",
      requestId: `command-${sent.length}`,
      runtimeId: channel.runtimeId,
      nativeSessionId: native,
      bindingId,
      method,
      args,
    });
  const configure = (id = bindingId) => {
    bindingId = id;
    command("configure", {
      version: 1,
      sessionId: "session",
      nativeSessionId: native,
      runtimeId: channel.runtimeId,
      bindingId,
      features: ["agentRequests.v1", "policies.v1"],
      coordinatorConnected: true,
      policyRequired: true,
      sessionUrl: "https://switchyard.test/session",
    });
  };
  configure();
  const requests = (method: string) =>
    sent.filter((r) => r.type === "agent.request" && r.method === method);
  const reply = (request: any, result: unknown, ok = true) =>
    channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok,
      ...(ok ? { result } : { error: result }),
    });
  const preflight = async (index = 0, args: unknown = { objective: "work" }) => {
    const hook = handlers.get("tool_call")!(
      { toolCallId: "call", toolName: tools[index].name, input: args },
      ctx,
    );
    await flush();
    reply(requests("receipt.peek").at(-1), { found: false });
    await flush();
    reply(requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
    expect(await hook).toBeUndefined();
  };
  const execute = (index = 0, args: unknown = { objective: "work" }) =>
    tools[index].execute("call", args, controller.signal, undefined, ctx);
  return {
    channel,
    ctx,
    controller,
    execute,
    preflight,
    requests,
    reply,
    command,
    configure,
    setNative: (id: string) => {
      native = id;
      channel.announce();
    },
  };
}

const ask = (decisionId = "decision") => ({
  type: "policy.required",
  decisionId,
  interactionId: `interaction-${decisionId}`,
  interactionUrl: `https://switchyard.test/approval/${decisionId}`,
});

async function beginAsk(f: ReturnType<typeof fixture>, index = 0, args?: unknown) {
  const method = ["task.create", "message.send", "inbox.read"][index];
  await f.preflight(index, args);
  const outcome = f.execute(index, args);
  await flush();
  f.reply(f.requests(method)[0], ask());
  await flush();
  return { outcome, method };
}

describe("request-phase tool policy resumption", () => {
  it.each([
    [0, { objective: "work", acceptance: ["verified"] }],
    [1, { sessionId: "recipient", body: "hello", mode: "queue" }],
    [2, { after: 0, limit: 20 }],
  ])(
    "keeps tool %i pending through >30s of healthy polls, then explicitly resubmits",
    async (index, args) => {
      const f = fixture();
      const original = JSON.parse(JSON.stringify(args));
      const { outcome, method } = await beginAsk(f, index, args);
      const done = vi.fn();
      void outcome.then(done);
      Object.assign(args, { changed: true });
      for (let i = 0; i < 3; i++) {
        const status = f.requests("policy.status").at(-1);
        expect(status.args).toEqual({ decisionId: "decision", waitMs: 25000 });
        await vi.advanceTimersByTimeAsync(25000);
        f.reply(status, { state: "pending" });
        await flush();
        expect(f.requests(method)).toHaveLength(1);
        expect(done).not.toHaveBeenCalled();
      }
      expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
        "Approval required in Switchyard: https://switchyard.test/approval/decision",
        "warning",
      );
      f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
      await flush();
      const [initial, resumed] = f.requests(method);
      expect(resumed.requestId).not.toBe(initial.requestId);
      expect(resumed.toolCallId).toBe(initial.toolCallId);
      expect(resumed.args).toEqual(original);
      expect(Date.parse(resumed.deadlineAt) - Date.parse(initial.deadlineAt)).toBe(75000);
      expect(Date.parse(resumed.deadlineAt) - Date.now()).toBe(30000);
      const final = { id: "completed", messages: [] };
      f.reply(resumed, final);
      await expect(outcome).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify(final) }],
        details: final,
      });
      expect(f.requests("policy.cancel")).toHaveLength(0);
    },
  );

  it("deduplicates notices for repeated decisions and handles a second distinct ASK", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    for (const decision of ["decision", "second"]) {
      f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
      await flush();
      f.reply(f.requests(method).at(-1), ask(decision));
      await flush();
    }
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.requests("policy.status").at(-1).args.decisionId).toBe("second");
    f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
    await flush();
    f.reply(f.requests(method).at(-1), { taskId: "task" });
    await expect(outcome).resolves.toMatchObject({ details: { taskId: "task" } });
    expect(f.requests(method)).toHaveLength(4);
    expect(new Set(f.requests(method).map((r) => r.toolCallId))).toEqual(new Set(["call"]));
  });

  it.each(["denied", "canceled"])(
    "returns a tool error on %s, not the wait envelope",
    async (state) => {
      const f = fixture();
      const { outcome, method } = await beginAsk(f);
      const rejected = expect(outcome).rejects.toThrow("No permission");
      f.reply(f.requests("policy.status")[0], { state, reason: "No permission" });
      await rejected;
      expect(f.requests(method)).toHaveLength(1);
      expect(f.requests("policy.cancel")).toHaveLength(1);
    },
  );

  it("cancels with a fresh independent 1s request and never resubmits on late approval", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    const rejected = expect(outcome).rejects.toMatchObject({ code: "conflict" });
    const status = f.requests("policy.status")[0];
    await vi.advanceTimersByTimeAsync(10000);
    f.controller.abort();
    await rejected;
    await flush();
    const cancellation = f.requests("policy.cancel");
    expect(cancellation).toHaveLength(1);
    expect(cancellation[0].args).toEqual({ decisionId: "decision" });
    expect(Date.parse(cancellation[0].deadlineAt) - Date.now()).toBe(1000);
    f.reply(status, { state: "allowed" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.requests(method)).toHaveLength(1);
  });

  it("aborts in the same turn as allowed status without emitting a resumed mutation", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    const rejected = expect(outcome).rejects.toMatchObject({ code: "conflict" });
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    f.controller.abort();
    await rejected;
    expect(f.requests(method)).toHaveLength(1);
  });

  it.each(["coordinator", "socket"])(
    "closes after 30s of %s loss without an orphan resubmit",
    async (loss) => {
      const f = fixture();
      const { outcome, method } = await beginAsk(f);
      const rejected = expect(outcome).rejects.toMatchObject({ code: "timeout" });
      const status = f.requests("policy.status")[0];
      if (loss === "coordinator") f.command("connection.update", { connected: false });
      else f.channel.onDisconnect();
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      f.channel.onConnect();
      f.configure("replacement");
      f.reply(status, { state: "allowed" });
      await flush();
      expect(f.requests(method)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
    },
  );

  it("allows a healthy same-binding coordinator reconnect within the existing poll deadline", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    const first = f.requests("policy.status")[0];
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(5000);
    f.command("connection.update", { connected: true });
    await flush();
    const retry = f.requests("policy.status").at(-1);
    expect(retry.requestId).not.toBe(first.requestId);
    expect(retry.deadlineAt).toBe(first.deadlineAt);
    f.reply(retry, { state: "allowed" });
    await flush();
    f.reply(f.requests(method).at(-1), { taskId: "task" });
    await expect(outcome).resolves.toMatchObject({ details: { taskId: "task" } });
  });

  it.each(["binding", "native", "close"])(
    "fences %s replacement while waiting",
    async (replacement) => {
      const f = fixture();
      const { outcome, method } = await beginAsk(f);
      const rejected = expect(outcome).rejects.toBeInstanceOf(Error);
      const oldStatus = f.requests("policy.status")[0];
      if (replacement === "native") f.setNative("other-native");
      if (replacement === "close") f.channel.close();
      else f.configure("new-binding");
      f.reply(oldStatus, { state: "allowed" });
      await rejected;
      expect(f.requests(method)).toHaveLength(1);
      expect(f.requests("policy.status")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
    },
  );

  it("does not retry a resumed mutation under a replacement binding", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    expect(f.requests(method)).toHaveLength(2);
    f.configure("replacement");
    await rejected;
    expect(f.requests(method)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it.each([
    { ...ask(), unexpected: true },
    { ...ask(), interactionUrl: "javascript:alert(1)" },
    { ...ask(), interactionUrl: "https://user:secret@switchyard.test" },
    { ...ask(), interactionId: "" },
  ])("rejects malformed or unsafe wait envelopes", async (wait) => {
    const f = fixture();
    await f.preflight();
    const outcome = f.execute();
    const rejected = expect(outcome).rejects.toMatchObject({ code: "invalid_request" });
    await flush();
    f.reply(f.requests("task.create")[0], wait);
    await rejected;
    expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    expect(f.requests("policy.status")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("rejects invalid status without treating it as approval", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    const rejected = expect(outcome).rejects.toMatchObject({ code: "invalid_request" });
    f.reply(f.requests("policy.status")[0], { state: "ALLOW" });
    await rejected;
    expect(f.requests(method)).toHaveLength(1);
  });

  it("keeps retries idempotent after a lost committed response", async () => {
    const f = fixture();
    const { outcome, method } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    const resumed = f.requests(method).at(-1);
    const receipts = new Map<string, unknown>();
    let mutations = 0;
    const executeServer = (request: any) => {
      const key = JSON.stringify([request.toolCallId, request.method, request.args]);
      if (!receipts.has(key)) {
        mutations++;
        receipts.set(key, { taskId: "only-task" });
      }
      return receipts.get(key);
    };
    executeServer(resumed); // committed, but its result is lost with the coordinator link
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(2000);
    f.command("connection.update", { connected: true });
    await flush();
    const retry = f.requests(method).at(-1);
    expect(retry.requestId).not.toBe(resumed.requestId);
    expect(retry.deadlineAt).toBe(resumed.deadlineAt);
    f.reply(retry, executeServer(retry));
    await expect(outcome).resolves.toMatchObject({ details: { taskId: "only-task" } });
    expect(mutations).toBe(1);
  });
});

describe("agent channel fixed wire deadlines", () => {
  it("uses the same canonical deadline and logical identity across transport retries", async () => {
    const f = fixture();
    const outcome = f.channel.request(
      "message.send",
      { body: "hello" },
      {
        toolCallId: "call",
        timeoutMs: 60000,
        binding: f.channel.snapshot().configuration!,
      },
    );
    await flush();
    const first = f.requests("message.send")[0];
    expect(first.deadlineAt).toBe("2026-01-01T00:00:30.000Z");
    expect(BridgeAgentRequest.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(AgentToolPolicyWait.parse(JSON.parse(JSON.stringify(ask())))).toEqual(ask());
    await vi.advanceTimersByTimeAsync(5000);
    f.reply(first, { code: "host_unreachable", message: "Offline" }, false);
    await vi.advanceTimersByTimeAsync(100);
    const second = f.requests("message.send")[1];
    expect(second.deadlineAt).toBe(first.deadlineAt);
    expect(second.toolCallId).toBe(first.toolCallId);
    expect(second.requestId).not.toBe(first.requestId);
    f.channel.onDisconnect();
    await vi.advanceTimersByTimeAsync(5000);
    f.channel.onConnect();
    f.configure();
    await flush();
    const third = f.requests("message.send")[2];
    expect(third.deadlineAt).toBe(first.deadlineAt);
    expect(third.args).toEqual(first.args);
    f.reply(third, { messageId: "message" });
    await expect(outcome).resolves.toEqual({ messageId: "message" });
  });

  it("rejects a replacement controller without retrying the original request", async () => {
    const f = fixture();
    const outcome = f.channel.request(
      "message.send",
      { body: "hello" },
      {
        toolCallId: "call",
        binding: f.channel.snapshot().configuration!,
      },
    );
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    await flush();
    const first = f.requests("message.send")[0];
    f.channel.onDisconnect();
    f.channel.onConnect();
    f.configure("replacement");
    f.reply(first, { messageId: "late" });
    await rejected;
    await flush();
    expect(f.requests("message.send")).toHaveLength(1);
  });

  it("never resets the deadline on repeated disconnects", async () => {
    const f = fixture();
    const outcome = f.channel.request(
      "inbox.read",
      {},
      {
        timeoutMs: 100,
        binding: f.channel.snapshot().configuration!,
      },
    );
    const rejected = expect(outcome).rejects.toMatchObject({ code: "timeout" });
    await flush();
    const first = f.requests("inbox.read")[0];
    await vi.advanceTimersByTimeAsync(40);
    f.channel.onDisconnect();
    f.channel.onConnect();
    f.configure();
    await flush();
    expect(f.requests("inbox.read")[1].deadlineAt).toBe(first.deadlineAt);
    await vi.advanceTimersByTimeAsync(60);
    await rejected;
    expect(f.requests("inbox.read")).toHaveLength(2);
  });

  it("rechecks cancellation after readiness and before sending a mutation", async () => {
    const f = fixture();
    const outcome = f.channel.request("task.create", {}, { signal: f.controller.signal });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "conflict" });
    f.controller.abort();
    await rejected;
    expect(f.requests("task.create")).toHaveLength(0);
  });
});
