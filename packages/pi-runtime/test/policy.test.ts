import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { installPolicyHooks } from "../src/bridge/policy.js";

const channels: ReturnType<typeof createAgentChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fixture(required = true) {
  const sent: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let native = "native";
  let installed = false;
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => native,
      getSessionFile: () => null,
      getBranch: () => [],
    },
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
      messageDelivery: false,
      editorDraftGuard: true,
      toolPolicy: installed,
    }),
    policyRequired: required,
  });
  channels.push(channel);
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
  installed = installPolicyHooks(pi, channel);
  channel.onConnect();
  let sequence = 0;
  const command = (method: string, args: unknown, bindingId = "binding") =>
    channel.receive({
      type: "bridge.command",
      requestId: `command-${sequence++}`,
      runtimeId: channel.runtimeId,
      nativeSessionId: native,
      bindingId,
      method,
      args,
    });
  const configure = (
    features = ["agentRequests.v1", "policies.v1"],
    bindingId = "binding",
    policyRequired = required,
  ) =>
    command(
      "configure",
      {
        version: 1,
        sessionId: "session",
        runtimeId: channel.runtimeId,
        nativeSessionId: native,
        bindingId,
        features,
        coordinatorConnected: true,
        policyRequired,
        sessionUrl: "https://switchyard.test/code/session",
      },
      bindingId,
    );
  const requests = (method: string) =>
    sent.filter((record) => record.type === "agent.request" && record.method === method);
  const reply = (request: any, result: unknown) =>
    channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result,
    });
  const event = {
    toolCallId: "call",
    toolName: "bash",
    input: { command: "echo safe", nested: { value: 1 } },
  };
  const run = (e: any = event) => handlers.get("tool_call")!(e, ctx);
  return {
    channel,
    handlers,
    sent,
    controller,
    ctx,
    command,
    configure,
    requests,
    reply,
    event,
    run,
    setNative: (id: string) => {
      native = id;
    },
  };
}

const ask = {
  verdict: "ASK",
  decisionId: "decision",
  interactionId: "interaction",
  interactionUrl: "https://switchyard.test/code/session",
};
async function beginAsk(f: ReturnType<typeof fixture>) {
  f.configure();
  const outcome = f.run();
  await flush();
  f.reply(f.requests("policy.evaluate")[0], ask);
  await flush();
  return { outcome };
}

describe("Pi policy hook", () => {
  it("installs the awaited tool hook synchronously and stops cache warming without I/O", () => {
    const f = fixture();
    expect([...f.handlers.keys()]).toEqual([
      "tool_call",
      "agent_settled",
      "session_shutdown",
      "cache_warming_decision",
    ]);
    const count = f.sent.length;
    expect(f.handlers.get("cache_warming_decision")!()).toEqual({ action: "stop" });
    expect(f.sent).toHaveLength(count);
    const outcome = f.run();
    expect(outcome).toBeInstanceOf(Promise);
    f.controller.abort();
    return expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
  });

  it("reports a missing hook API instead of advertising protection", () => {
    const f = fixture();
    expect(() => installPolicyHooks({} as any, f.channel)).toThrow("awaited tool_call hook API");
  });

  it("leaves optional legacy hooks usable before configure and with an old coordinator", async () => {
    const f = fixture(false);
    await expect(f.run()).resolves.toBeUndefined();
    f.configure([]);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.requests("policy.evaluate")).toEqual([]);
  });

  it("fails required hooks closed before configure after exactly 30 seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const outcome = f.run();
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.requests("policy.evaluate")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({
      block: true,
      terminate: true,
      reason: "Coordinator communication timed out",
    });
  });

  it("does not reset the initial readiness/evaluation deadline after configure", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const outcome = f.run();
    await vi.advanceTimersByTimeAsync(29000);
    f.configure();
    await flush();
    expect(f.requests("policy.evaluate")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Coordinator communication timed out",
    });
  });

  it("keeps required enforcement latched across unsupported configurations", async () => {
    const f = fixture(false);
    f.configure([], "first", true);
    await expect(f.run()).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: expect.stringContaining("does not support"),
    });
    f.configure([], "second", false);
    await expect(f.run()).resolves.toMatchObject({ block: true, terminate: true });
    expect(f.channel.snapshot().policyRequired).toBe(true);
  });

  it("sends the exact evaluation contract with cloned normalized arguments and deterministic identity", async () => {
    const f = fixture();
    f.configure();
    const outcome = f.run();
    await flush();
    const request = f.requests("policy.evaluate")[0];
    expect(request.toolCallId).toBe("call");
    expect(request.args).toEqual({
      evaluationId: `pol_${createHash("sha256")
        .update(JSON.stringify(["session", "native", "tool_call", "call"]))
        .digest("hex")}`,
      toolCallId: "call",
      tool: { name: "bash", args: f.event.input },
    });
    expect(request.args.tool.args).not.toBe(f.event.input);
    expect(request.args.tool.args.nested).not.toBe(f.event.input.nested);
    expect(Object.isFrozen(f.event.input)).toBe(false);
    f.reply(request, { verdict: "ALLOW" });
    await expect(outcome).resolves.toBeUndefined();
  });

  it.each([
    [{ verdict: "DENY", reason: "No shell access" }, "No shell access"],
    [{ verdict: "UNKNOWN" }, "Invalid policy evaluation reply."],
    [{ verdict: "DENY" }, "Invalid policy reply."],
    [null, "Invalid policy reply."],
  ])("blocks denied or invalid evaluations %j", async (reply, reason) => {
    const f = fixture();
    f.configure();
    const outcome = f.run();
    await flush();
    f.reply(f.requests("policy.evaluate")[0], reply);
    await expect(outcome).resolves.toEqual({ block: true, terminate: true, reason });
  });

  it("waits for human approval beyond 30 seconds while healthy and notifies only once", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { outcome } = await beginAsk(f);
    for (let i = 0; i < 4; i++) {
      const request = f.requests("policy.status").at(-1);
      expect(request.args).toEqual({ decisionId: "decision", waitMs: 25000 });
      await vi.advanceTimersByTimeAsync(25000);
      f.reply(request, { state: "pending" });
      await flush();
    }
    expect(f.ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      "Approval required in Switchyard: https://switchyard.test/code/session",
      "warning",
    );
    f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
    await flush();
    f.reply(f.requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
    await expect(outcome).resolves.toBeUndefined();
    expect(f.requests("policy.cancel")).toHaveLength(0);
  });

  it("refreshes proof only after all ASK rules allow, using the same detached logical action", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    const original = f.requests("policy.evaluate")[0];
    for (let i = 0; i < 3; i++) {
      // The service can move to another interaction while the whole decision stays pending.
      f.reply(f.requests("policy.status").at(-1), { state: "pending" });
      await flush();
      expect(f.requests("policy.evaluate")).toHaveLength(1);
      expect(f.requests("policy.status").at(-1).args.decisionId).toBe("decision");
    }
    let finished = false;
    void outcome.then(() => {
      finished = true;
    });
    f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
    await flush();
    const refreshed = f.requests("policy.evaluate")[1];
    expect(finished).toBe(false);
    expect(refreshed.requestId).not.toBe(original.requestId);
    expect(refreshed.toolCallId).toBe(original.toolCallId);
    expect(refreshed.args).toEqual(original.args);
    expect(refreshed.args.tool.args).not.toBe(f.event.input);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
    f.reply(refreshed, { verdict: "ALLOW" });
    await expect(outcome).resolves.toBeUndefined();
    expect(f.requests("policy.evaluate")).toHaveLength(2);
    expect(f.requests("policy.cancel")).toHaveLength(0);
  });

  it("never refreshes or allows when a later ASK rule denies the whole authorization", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "pending" });
    await flush();
    f.reply(f.requests("policy.status")[1], { state: "denied", reason: "Later rule denied" });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Later rule denied",
    });
    expect(f.requests("policy.evaluate")).toHaveLength(1);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ verdict: "DENY", reason: "Host proof changed" }, "Host proof changed"],
    [ask, "Policy authorization changed after approval; the action was blocked."],
    [{ verdict: "UNKNOWN" }, "Invalid policy evaluation reply."],
    [{ verdict: "DENY" }, "Invalid policy reply."],
    [null, "Invalid policy reply."],
  ])(
    "fails closed on the final proof refresh %j without another approval loop",
    async (result, reason) => {
      const f = fixture();
      const { outcome } = await beginAsk(f);
      f.reply(f.requests("policy.status")[0], { state: "allowed" });
      await flush();
      f.reply(f.requests("policy.evaluate")[1], result);
      await expect(outcome).resolves.toEqual({ block: true, terminate: true, reason });
      await flush();
      expect(f.requests("policy.evaluate")).toHaveLength(2);
      expect(f.requests("policy.status")).toHaveLength(1);
      expect(f.requests("policy.cancel")).toHaveLength(1);
      expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry stale host proof returned by the post-approval evaluation", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    const refreshed = f.requests("policy.evaluate")[1];
    f.channel.receive({
      type: "agent.result",
      requestId: refreshed.requestId,
      runtimeId: refreshed.runtimeId,
      bindingId: refreshed.bindingId,
      ok: false,
      error: { code: "stale_control", message: "Pinned workspace boundary changed" },
    });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Pinned workspace boundary changed",
    });
    expect(f.requests("policy.evaluate")).toHaveLength(2);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("bounds post-approval proof refresh to 30 seconds independently of healthy human waiting", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { outcome } = await beginAsk(f);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25000);
      f.reply(f.requests("policy.status").at(-1), { state: "pending" });
      await flush();
    }
    f.reply(f.requests("policy.status").at(-1), { state: "allowed" });
    await flush();
    expect(f.requests("policy.evaluate")).toHaveLength(2);
    let finished = false;
    void outcome.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Coordinator communication timed out",
    });
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("blocks final proof refresh after controller replacement without retrying or releasing the call", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    const old = f.requests("policy.evaluate")[1];
    f.channel.onControlAttached();
    f.configure(undefined, "replacement");
    await flush();
    // A late ALLOW from the retired controller cannot release the original call.
    f.reply(old, { verdict: "ALLOW" });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Bridge binding changed during tool authorization",
    });
    expect(f.requests("policy.evaluate")).toHaveLength(2);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(f.requests("policy.status")).toHaveLength(1);
  });

  it("does not restart the final proof refresh deadline on reconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(19000);
    f.command("connection.update", { connected: true });
    await flush();
    expect(f.requests("policy.evaluate")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Coordinator communication timed out",
    });
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("cancels once if Escape aborts the final proof refresh", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    f.controller.abort();
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Policy approval canceled.",
    });
    await flush();
    expect(f.requests("policy.cancel")).toHaveLength(1);
    expect(f.requests("policy.evaluate")).toHaveLength(2);
  });

  it.each(["input", "name", "id", "native", "binding"])(
    "rechecks %s after the final proof refresh",
    async (field) => {
      const f = fixture();
      const { outcome } = await beginAsk(f);
      f.reply(f.requests("policy.status")[0], { state: "allowed" });
      await flush();
      const refreshed = f.requests("policy.evaluate")[1];
      if (field === "input") f.event.input.nested.value = 2;
      if (field === "name") f.event.toolName = "write";
      if (field === "id") f.event.toolCallId = "substitute";
      if (field === "native") f.setNative("other-native");
      // Synchronously change configuration between receipt and the hook's continuation.
      f.reply(refreshed, { verdict: "ALLOW" });
      if (field === "binding") {
        f.command("configure", {
          ...f.channel.snapshot().configuration,
          sessionId: "other-session",
        });
      }
      await expect(outcome).resolves.toMatchObject({ block: true, terminate: true });
      expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["denied", "canceled"])("blocks a %s approval", async (state) => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state, reason: "Stopped by owner" });
    await expect(outcome).resolves.toEqual({
      block: true,
      terminate: true,
      reason: "Stopped by owner",
    });
  });

  it("blocks malformed approval status and unsafe approval URLs", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.reply(f.requests("policy.status")[0], { state: "success" });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      reason: "Invalid policy status reply.",
    });
    const other = f.run();
    await flush();
    f.reply(f.requests("policy.evaluate").at(-1), {
      ...ask,
      interactionUrl: "https://secret:token@switchyard.test/code/session",
    });
    await expect(other).resolves.toMatchObject({
      block: true,
      reason: "Invalid policy approval URL.",
    });
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("cancels an Escape-aborted healthy wait and sends one best-effort cancellation", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.controller.abort();
    await expect(outcome).resolves.toEqual({
      block: true,
      terminate: true,
      reason: "Policy approval canceled.",
    });
    await flush();
    expect(f.requests("policy.cancel")).toHaveLength(1);
    expect(f.requests("policy.cancel")[0].args).toEqual({ decisionId: "decision" });
  });

  it("resumes polling after a healthy same-binding reconnect without repeating the notice", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { outcome } = await beginAsk(f);
    const old = f.requests("policy.status")[0];
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(29000);
    f.reply(old, { state: "allowed" });
    f.command("connection.update", { connected: true });
    await flush();
    const current = f.requests("policy.status").at(-1);
    expect(current.requestId).not.toBe(old.requestId);
    f.reply(current, { state: "allowed" });
    await flush();
    f.reply(f.requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
    await expect(outcome).resolves.toBeUndefined();
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("blocks a 30-second communication loss without restarting the status deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { outcome } = await beginAsk(f);
    await vi.advanceTimersByTimeAsync(10000);
    f.command("connection.update", { connected: false });
    await vi.advanceTimersByTimeAsync(19000);
    f.command("connection.update", { connected: true });
    await flush();
    expect(f.requests("policy.status")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Coordinator communication timed out",
    });
  });

  it("does not retry permanent policy errors", async () => {
    const f = fixture();
    f.configure();
    const outcome = f.run();
    await flush();
    const request = f.requests("policy.evaluate")[0];
    f.channel.receive({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: false,
      error: { code: "conflict", message: "Stale policy context" },
    });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Stale policy context",
    });
    expect(f.requests("policy.evaluate")).toHaveLength(1);
  });

  it("blocks an evaluation when its controller is replaced, even on a late ALLOW", async () => {
    const f = fixture();
    f.configure();
    const outcome = f.run();
    await flush();
    const old = f.requests("policy.evaluate")[0];
    f.channel.onControlAttached();
    f.configure(undefined, "replacement");
    await flush();
    f.reply(old, { verdict: "ALLOW" });
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Bridge binding changed during tool authorization",
    });
    expect(f.requests("policy.evaluate")).toHaveLength(1);
  });

  it.each(["input", "name", "id"])(
    "blocks %s mutation while awaiting approval without freezing Pi input",
    async (field) => {
      const f = fixture();
      const { outcome } = await beginAsk(f);
      if (field === "input") f.event.input.nested.value = 2;
      if (field === "name") f.event.toolName = "write";
      if (field === "id") f.event.toolCallId = "substitute";
      expect(f.requests("policy.evaluate")[0].args.tool.args.nested.value).toBe(1);
      f.reply(f.requests("policy.status")[0], { state: "allowed" });
      await expect(outcome).resolves.toMatchObject({
        block: true,
        terminate: true,
        reason: expect.stringContaining("changed during policy authorization"),
      });
    },
  );

  it("blocks a native session switch instead of accepting approval for another native session", async () => {
    const f = fixture();
    const { outcome } = await beginAsk(f);
    f.setNative("other-native");
    f.channel.announce();
    await expect(outcome).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Native session changed",
    });
  });

  it("does not allow an optional previously protected hook to fail open on lost connectivity", async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    f.configure();
    const first = f.run();
    await flush();
    f.reply(f.requests("policy.evaluate")[0], { verdict: "ALLOW" });
    await first;
    f.channel.onDisconnect();
    const second = f.run();
    await vi.advanceTimersByTimeAsync(30000);
    await expect(second).resolves.toMatchObject({ block: true, terminate: true });
  });

  it.each([
    undefined,
    [],
    { bad: Number.NaN },
    { bad: undefined },
    { bad: 1n },
    new Date(),
    JSON.parse('{"constructor":"bad"}'),
  ])(
    "rejects non-JSON or invalid tool arguments %s before asking for authorization",
    async (input) => {
      const f = fixture();
      f.configure();
      await expect(f.run({ ...f.event, input })).resolves.toMatchObject({
        block: true,
        terminate: true,
      });
      expect(f.requests("policy.evaluate")).toHaveLength(0);
    },
  );
});
