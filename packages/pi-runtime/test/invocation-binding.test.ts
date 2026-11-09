import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentBindingIdentity, createAgentChannel } from "../src/bridge/agent-channel.js";
import { registerAgentTools } from "../src/bridge/agent-tools.js";
import { installPolicyHooks } from "../src/bridge/policy.js";

const channels: ReturnType<typeof createAgentChannel>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.useRealTimers();
});
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function fixture(configured = true) {
  const sent: any[] = [];
  const tools: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let native = "native";
  let hookNative = "native";
  let bindingId = "binding";
  let sessionId = "session";
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    sessionManager: { getSessionId: () => hookNative },
    ui: { notify: vi.fn() },
  };
  const channel = createAgentChannel({
    send: (record) => {
      sent.push(record);
      return true;
    },
    getContext: () => ({ sessionManager: { getSessionId: () => native, getBranch: () => [] } }),
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
  const configure = (id = bindingId, session = sessionId) => {
    bindingId = id;
    sessionId = session;
    command("configure", {
      version: 1,
      sessionId,
      runtimeId: channel.runtimeId,
      nativeSessionId: native,
      bindingId,
      features: ["agentRequests.v1", "policies.v1"],
      coordinatorConnected: true,
      policyRequired: true,
      sessionUrl: null,
    });
  };
  if (configured) configure();
  const pin = (): AgentBindingIdentity => ({
    sessionId,
    runtimeId: channel.runtimeId,
    nativeSessionId: native,
    bindingId,
  });
  const requests = (method?: string) =>
    sent.filter((r) => r.type === "agent.request" && (!method || r.method === method));
  const reply = (request: any, result: unknown, ok = true) =>
    channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok,
      ...(ok ? { result } : { error: result }),
    });
  const runHook = () =>
    handlers.get("tool_call")!(
      { toolCallId: "call", toolName: "bash", input: { command: "echo safe" } },
      ctx,
    );
  const execute = (index = 0) =>
    tools[index].execute("call", { objective: "work" }, controller.signal, undefined, ctx);
  return {
    channel,
    sent,
    command,
    configure,
    pin,
    requests,
    reply,
    runHook,
    execute,
    ctx,
    controller,
    setNative: (id: string) => {
      native = id;
      hookNative = id;
      channel.announce();
    },
    setHookNative: (id: string) => {
      hookNative = id;
    },
  };
}

const ask = {
  verdict: "ASK",
  decisionId: "decision",
  interactionId: "interaction",
  interactionUrl: "https://switchyard.test/approval/decision",
};
const toolAsk = {
  type: "policy.required",
  decisionId: ask.decisionId,
  interactionId: ask.interactionId,
  interactionUrl: ask.interactionUrl,
};

async function hookAt(f: ReturnType<typeof fixture>, phase: string) {
  const outcome: Promise<unknown> = f.runHook();
  await flush();
  if (phase !== "evaluate") {
    f.reply(f.requests("policy.evaluate")[0], ask);
    await flush();
  }
  if (phase === "proof") {
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
  }
  return { outcome };
}

async function toolAt(f: ReturnType<typeof fixture>, phase: string, index = 0) {
  const method = ["task.create", "message.send", "inbox.read"][index];
  const outcome: Promise<unknown> = f.execute(index);
  await flush();
  if (phase !== "request") {
    f.reply(f.requests(method)[0], toolAsk);
    await flush();
  }
  if (phase === "resume") {
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
  }
  return { outcome, method };
}

describe("agent channel exact local binding fence", () => {
  it.each(["sessionId", "runtimeId", "nativeSessionId", "bindingId"] as const)(
    "rejects a mismatched %s before encoding any request",
    async (field) => {
      const f = fixture();
      const binding = { ...f.pin(), [field]: "substitute" };
      await expect(f.channel.request("inbox.read", {}, { binding })).rejects.toMatchObject({
        code: "stale_control",
      });
      expect(f.requests()).toEqual([]);
    },
  );

  it.each(["readiness", "in-flight", "result", "retry-backoff"])(
    "rejects replacement during %s, including same runtime/native",
    async (phase) => {
      const f = fixture();
      const binding = f.pin();
      if (phase === "readiness") f.command("connection.update", { connected: false });
      const outcome = f.channel.request("inbox.read", {}, { binding });
      const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
      await flush();
      const request = f.requests()[0];
      if (phase === "result") f.reply(request, { messages: [] });
      if (phase === "retry-backoff") {
        f.reply(request, { code: "host_unreachable", message: "Offline" }, false);
        await flush();
      }
      f.configure("replacement");
      await rejected;
      expect(f.requests()).toHaveLength(phase === "readiness" ? 0 : 1);
    },
  );

  it("invalidates immediately on control attachment, without waiting for configure", async () => {
    const f = fixture();
    const outcome = f.channel.request("policy.status", { decisionId: "d" }, { binding: f.pin() });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    await flush();
    f.channel.onControlAttached();
    await rejected;
    expect(f.channel.snapshot().configuration).toBeNull();
  });

  it("cannot restore retired authority with a delayed A -> B -> A configure", async () => {
    const f = fixture();
    const binding = f.pin();
    const outcome = f.channel.request("inbox.read", {}, { binding });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    await flush();
    f.configure("replacement");
    f.configure(binding.bindingId);
    await rejected;
    expect(f.channel.snapshot().configuration?.bindingId).toBe("replacement");
    expect(f.sent.at(-1)).toMatchObject({ ok: false, error: { code: "stale_control" } });
  });

  it("copies the caller pin instead of allowing its mutation to redirect a retry", async () => {
    const f = fixture();
    const binding = f.pin();
    const outcome = f.channel.request("inbox.read", {}, { binding });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    await flush();
    binding.bindingId = "replacement";
    f.configure("replacement");
    await rejected;
    expect(f.requests()).toHaveLength(1);
  });

  it.each(["coordinator", "socket"])(
    "recovers %s loss only under the same binding and original deadline",
    async (loss) => {
      const f = fixture();
      const binding = f.pin();
      const outcome = f.channel.request("inbox.read", {}, { binding });
      await flush();
      const first = f.requests()[0];
      if (loss === "coordinator") f.command("connection.update", { connected: false });
      else f.channel.onDisconnect();
      await vi.advanceTimersByTimeAsync(29000);
      if (loss === "coordinator") f.command("connection.update", { connected: true });
      else {
        f.channel.onConnect();
        f.configure();
      }
      await flush();
      const retry = f.requests()[1];
      expect(retry.requestId).not.toBe(first.requestId);
      expect(retry.deadlineAt).toBe(first.deadlineAt);
      expect(retry.bindingId).toBe(binding.bindingId);
      expect(retry).not.toHaveProperty("binding");
      f.reply(retry, { messages: [] });
      await expect(outcome).resolves.toEqual({ messages: [] });
    },
  );

  it("does not extend the pinned deadline across a same-binding reconnect", async () => {
    const f = fixture();
    const outcome = f.channel.request("inbox.read", {}, { binding: f.pin() });
    const rejected = expect(outcome).rejects.toMatchObject({ code: "timeout" });
    await flush();
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(29000);
    f.command("connection.update", { connected: true });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(f.requests()).toHaveLength(2);
  });
});

describe("first legitimate startup readiness", () => {
  it.each(["hook", "tool"])(
    "does not launder a %s through replacement before its readiness continuation",
    async (kind) => {
      const f = fixture(false);
      const outcome: Promise<unknown> = kind === "hook" ? f.runHook() : f.execute();
      const checked =
        kind === "hook"
          ? expect(outcome).resolves.toMatchObject({ block: true, terminate: true })
          : expect(outcome).rejects.toMatchObject({ code: "stale_control" });
      // Both configurations arrive in one turn, before any promise continuation runs.
      f.configure("first-ready");
      f.configure("replacement");
      await checked;
      expect(f.requests()).toEqual([]);
    },
  );
});

describe("tool-call policy invocation binding", () => {
  it.each(["evaluate", "status", "proof"])(
    "blocks replacement during %s without retry or cancellation as the new controller",
    async (phase) => {
      const f = fixture();
      const captured = f.pin();
      const request = vi.spyOn(f.channel, "request");
      const { outcome } = await hookAt(f, phase);
      const count = f.requests().length;
      f.configure("replacement");
      await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
      await flush();
      expect(f.requests()).toHaveLength(count);
      for (const [, , options] of request.mock.calls) expect(options?.binding).toEqual(captured);
      if (phase !== "evaluate")
        expect(request.mock.calls.at(-1)).toMatchObject([
          "policy.cancel",
          { decisionId: "decision" },
          { binding: captured, timeoutMs: 1000 },
        ]);
      // A new invocation is allowed to use the new controller, not the stale one.
      const fresh = f.runHook();
      await flush();
      f.reply(f.requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
      await expect(fresh).resolves.toBeUndefined();
    },
  );

  it("pins an existing configuration before its initial readiness wait", async () => {
    const f = fixture();
    f.command("connection.update", { connected: false });
    const outcome = f.runHook();
    f.configure("replacement");
    await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
    expect(f.requests()).toEqual([]);
  });

  it("captures the first legitimate startup readiness and never a later configuration", async () => {
    const f = fixture(false);
    const outcome = f.runHook();
    f.configure();
    await flush();
    expect(f.requests("policy.evaluate")).toHaveLength(1);
    f.configure("replacement");
    await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
    expect(f.requests("policy.evaluate")).toHaveLength(1);
  });

  it.each(["binding", "session", "native", "hook-native"])(
    "rechecks %s between the final ALLOW receipt and hook return",
    async (change) => {
      const f = fixture();
      const { outcome } = await hookAt(f, "proof");
      f.reply(f.requests("policy.evaluate")[1], { verdict: "ALLOW" });
      if (change === "binding") f.configure("replacement");
      if (change === "session") f.configure("binding", "other-session");
      if (change === "native") f.setNative("other-native");
      if (change === "hook-native") f.setHookNative("other-native");
      await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
    },
  );

  it.each(["evaluate", "status", "proof"])(
    "allows a same-binding reconnect during %s",
    async (phase) => {
      const f = fixture();
      const { outcome } = await hookAt(f, phase);
      const old = f.requests().at(-1);
      f.command("connection.update", { connected: false });
      await vi.advanceTimersByTimeAsync(5000);
      f.command("connection.update", { connected: true });
      await flush();
      const retry = f.requests().at(-1);
      expect(retry.requestId).not.toBe(old.requestId);
      expect(retry.deadlineAt).toBe(old.deadlineAt);
      f.reply(retry, phase === "status" ? { state: "allowed" } : { verdict: "ALLOW" });
      if (phase === "status") {
        await flush();
        f.reply(f.requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
      }
      await expect(outcome).resolves.toBeUndefined();
    },
  );

  it("pins best-effort Escape cancellation without reusing the aborted signal", async () => {
    const f = fixture();
    const request = vi.spyOn(f.channel, "request");
    const { outcome } = await hookAt(f, "status");
    f.controller.abort();
    await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
    await flush();
    const options = request.mock.calls.find(([method]) => method === "policy.cancel")?.[2];
    expect(options).toEqual({ binding: f.pin(), timeoutMs: 1000 });
    expect(f.requests("policy.cancel")).toHaveLength(1);
  });
});

describe("request-tool invocation binding", () => {
  it.each([0, 1, 2])("pins tool %i before initial readiness", async (index) => {
    const f = fixture();
    f.command("connection.update", { connected: false });
    const outcome = f.execute(index);
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    f.configure("replacement");
    await rejected;
    expect(f.requests()).toEqual([]);
  });

  it.each(["request", "status", "resume"])(
    "never retries or resumes an old mutation after replacement during %s",
    async (phase) => {
      const f = fixture();
      const captured = f.pin();
      const request = vi.spyOn(f.channel, "request");
      const { outcome } = await toolAt(f, phase);
      const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
      const count = f.requests().length;
      f.configure("replacement");
      await rejected;
      await flush();
      expect(f.requests()).toHaveLength(count);
      for (const [, , options] of request.mock.calls) expect(options?.binding).toEqual(captured);
    },
  );

  it("cannot resubmit after an allowed status races controller replacement", async () => {
    const f = fixture();
    const { outcome, method } = await toolAt(f, "status");
    const rejected = expect(outcome).rejects.toMatchObject({ code: "stale_control" });
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    f.configure("replacement");
    await rejected;
    expect(f.requests(method)).toHaveLength(1);
    expect(f.requests("policy.cancel")).toHaveLength(0);
  });

  it("captures startup readiness without requiring a native session file", async () => {
    const f = fixture(false);
    const outcome = f.execute();
    f.configure();
    await flush();
    f.reply(f.requests("task.create")[0], { taskId: "task" });
    await expect(outcome).resolves.toMatchObject({ details: { taskId: "task" } });
  });

  it("preserves healthy ASK >30s, normalized arguments, explicit resumption and cancellation pins", async () => {
    const f = fixture();
    const request = vi.spyOn(f.channel, "request");
    const { outcome, method } = await toolAt(f, "status");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25000);
      f.reply(f.requests("policy.status").at(-1), { state: "pending" });
      await flush();
      expect(f.requests(method)).toHaveLength(1);
    }
    const oldPoll = f.requests("policy.status").at(-1);
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(1000);
    f.command("connection.update", { connected: true });
    await flush();
    const poll = f.requests("policy.status").at(-1);
    expect(poll.deadlineAt).toBe(oldPoll.deadlineAt);
    f.reply(poll, { state: "allowed" });
    await flush();
    const [initial, resumed] = f.requests(method);
    expect(resumed.args).toEqual(initial.args);
    expect(resumed.toolCallId).toBe(initial.toolCallId);
    expect(resumed.deadlineAt).not.toBe(initial.deadlineAt);
    f.reply(resumed, toolAsk);
    await flush();
    const rejected = expect(outcome).rejects.toMatchObject({ code: "conflict" });
    f.controller.abort();
    await rejected;
    await flush();
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(f.requests("policy.cancel")).toHaveLength(1);
    for (const [, , options] of request.mock.calls) expect(options?.binding).toEqual(f.pin());
    expect(request.mock.calls.at(-1)?.[2]).toEqual({ binding: f.pin(), timeoutMs: 1000 });
  });
});
