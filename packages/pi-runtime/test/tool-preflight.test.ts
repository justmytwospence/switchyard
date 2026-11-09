import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";
import { registerAgentTools } from "../src/bridge/agent-tools.js";
import { installPolicyHooks } from "../src/bridge/policy.js";
import {
  beginAgentToolPreflight,
  consumeAgentToolPreflight,
  DuplicateAgentToolPreflightError,
  releaseAgentToolPreflight,
  rememberAgentToolPreflight,
} from "../src/bridge/tool-preflight.js";

const channels: ReturnType<typeof createAgentChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.useRealTimers();
});
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const hash = "a".repeat(64);
const methods = ["task.create", "message.send", "inbox.read"];
const inputs = [
  { objective: "work" },
  { sessionId: "recipient", body: "hello", mode: "queue" },
  {},
];
function fixture(required = true, features = ["agentRequests.v1", "policies.v1"]) {
  const sent: any[] = [];
  const tools: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const controller = new AbortController();
  let native = "native";
  const ctx = {
    signal: controller.signal,
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionId: () => native, getBranch: () => [] },
    ui: { notify: vi.fn() },
  };
  const channel = createAgentChannel({
    send: (r) => {
      sent.push(r);
      return true;
    },
    getContext: () => ctx,
    appendEntry: vi.fn(),
    mode: "rpc",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: false,
      editorDraftGuard: true,
      toolPolicy: true,
    }),
    policyRequired: required,
  });
  channels.push(channel);
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.push(tool),
  };
  // Real bridges may install in either order. The name mapping is read at invocation time.
  installPolicyHooks(pi, channel);
  registerAgentTools(pi, channel);
  channel.onConnect();
  const configure = (changes: Record<string, unknown> = {}) =>
    channel.receive({
      type: "bridge.command",
      requestId: `configure-${sent.length}`,
      method: "configure",
      runtimeId: channel.runtimeId,
      nativeSessionId: native,
      bindingId: changes.bindingId ?? "binding",
      args: {
        version: 1,
        sessionId: "session",
        runtimeId: channel.runtimeId,
        nativeSessionId: native,
        bindingId: "binding",
        features,
        coordinatorConnected: true,
        policyRequired: required,
        sessionUrl: null,
        ...changes,
      },
    });
  configure();
  const requests = (method?: string) =>
    sent.filter((r) => r.type === "agent.request" && (!method || r.method === method));
  const reply = (r: any, result: unknown, ok = true) =>
    channel.receive({
      type: "agent.result",
      requestId: r.requestId,
      runtimeId: r.runtimeId,
      bindingId: r.bindingId,
      ok,
      ...(ok ? { result } : { error: result }),
    });
  const event = (index = 0, toolCallId = "call") => ({
    toolName: tools[index].name,
    toolCallId,
    input: structuredClone(inputs[index]),
  });
  const hook = (e = event()) => handlers.get("tool_call")!(e, ctx);
  const execute = (index = 0, id = "call", args = inputs[index]) =>
    tools[index].execute(id, args, ctx.signal, undefined, ctx);
  const end = (index = 0, id = "call") =>
    handlers.get("tool_execution_end")?.({
      toolName: tools[index].name,
      toolCallId: id,
    });
  return {
    channel,
    tools,
    handlers,
    requests,
    reply,
    event,
    hook,
    execute,
    end,
    settled: () => handlers.get("agent_settled")!({}, ctx),
    configure,
    controller,
    ctx,
    setNative: (id: string) => {
      native = id;
      channel.announce();
    },
  };
}
async function receipt(f: ReturnType<typeof fixture>, index = 0, id = "call") {
  const outcome = f.hook(f.event(index, id));
  await flush();
  f.reply(f.requests("receipt.peek").at(-1), { found: true, requestHash: hash });
  await expect(outcome).resolves.toBeUndefined();
}
async function normal(f: ReturnType<typeof fixture>, index = 0, id = "call") {
  const outcome = f.hook(f.event(index, id));
  await flush();
  f.reply(f.requests("receipt.peek").at(-1), { found: false });
  await flush();
  f.reply(f.requests("policy.evaluate").at(-1), { verdict: "ALLOW" });
  await expect(outcome).resolves.toBeUndefined();
}

describe("receipt preflight hook-to-execute handoff", () => {
  it.each([0, 1, 2])(
    "replays tool %i before stale policy evaluation, using only its recorded result",
    async (index) => {
      const f = fixture();
      expect(f.tools).toHaveLength(3); // receipt.peek is hidden, not a registered tool.
      await receipt(f, index);
      const peek = f.requests("receipt.peek")[0];
      expect(peek).toMatchObject({
        args: { method: methods[index], args: inputs[index] },
        toolCallId: "call",
        bindingId: "binding",
      });
      expect(f.requests("policy.evaluate")).toEqual([]);
      const outcome = f.execute(index);
      await flush();
      const replay = f.requests(methods[index])[0];
      expect(replay).toMatchObject({
        args: inputs[index],
        toolCallId: "call",
        receiptReplay: { requestHash: hash },
        bindingId: "binding",
      });
      const result = { id: "original", messages: [] };
      f.reply(replay, result);
      await expect(outcome).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      });
      expect(f.requests().map((r) => r.method)).toEqual(["receipt.peek", methods[index]]);
      await expect(f.execute(index)).rejects.toThrow("preflight is missing");
    },
  );

  it.each(["deleted receipt", "stored permanent error"])(
    "throws %s without approval, resumption or mutation fallback",
    async (kind) => {
      const f = fixture();
      await receipt(f);
      const outcome = f.execute();
      const rejected = expect(outcome).rejects.toMatchObject({ code: "conflict", message: kind });
      await flush();
      f.reply(f.requests("task.create")[0], { code: "conflict", message: kind }, false);
      await rejected;
      expect(f.requests().map((r) => r.method)).toEqual(["receipt.peek", "task.create"]);
      expect(f.ctx.ui.notify).not.toHaveBeenCalled();
      await receipt(f); // Error rendering still runs the claimed adapter's finally.
    },
  );

  it("rejects an impossible ASK in receipt mode without entering normal authorization", async () => {
    const f = fixture();
    await receipt(f);
    const outcome = f.execute();
    const rejected = expect(outcome).rejects.toThrow("cannot request approval");
    await flush();
    f.reply(f.requests("task.create")[0], {
      type: "policy.required",
      decisionId: "d",
      interactionId: "i",
      interactionUrl: "https://test/ask",
    });
    await rejected;
    expect(f.requests("policy.status")).toEqual([]);
  });

  it.each([0, 1, 2])(
    "keeps the complete policy path for tool %i after an ordinary miss",
    async (index) => {
      const f = fixture();
      await normal(f, index);
      expect(f.requests("policy.evaluate")[0].args.tool).toEqual({
        name: f.tools[index].name,
        args: inputs[index],
      });
      const outcome = f.execute(index);
      await flush();
      const request = f.requests(methods[index])[0];
      expect(request).not.toHaveProperty("receiptReplay");
      f.reply(request, { id: "fresh" });
      await expect(outcome).resolves.toMatchObject({ details: { id: "fresh" } });
    },
  );

  it("retains normal request ASK/status/explicit resubmission after the hook ALLOW", async () => {
    const f = fixture();
    await normal(f);
    const outcome = f.execute();
    await flush();
    f.reply(f.requests("task.create")[0], {
      type: "policy.required",
      decisionId: "d",
      interactionId: "i",
      interactionUrl: "https://test/ask",
    });
    await flush();
    f.reply(f.requests("policy.status")[0], { state: "allowed" });
    await flush();
    const resumed = f.requests("task.create")[1];
    expect(resumed).not.toHaveProperty("receiptReplay");
    f.reply(resumed, { id: "fresh" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "fresh" } });
  });

  it("does not produce a normal handoff after a miss and current DENY", async () => {
    const f = fixture();
    const outcome = f.hook();
    await flush();
    f.reply(f.requests("receipt.peek")[0], { found: false });
    await flush();
    f.reply(f.requests("policy.evaluate")[0], { verdict: "DENY", reason: "Root completed" });
    await expect(outcome).resolves.toMatchObject({ block: true, reason: "Root completed" });
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests("task.create")).toEqual([]);
  });

  it.each(["bash", "switchyard_create_task_extra", "third_party"])(
    "never peeks or exempts %s with a reused tool ID",
    async (toolName) => {
      const f = fixture();
      await receipt(f);
      const outcome = f.hook({ toolName, toolCallId: "call", input: { command: "rm -rf /" } });
      await flush();
      f.reply(f.requests("policy.evaluate")[0], { verdict: "DENY", reason: "No" });
      await expect(outcome).resolves.toMatchObject({ block: true });
      expect(f.requests("receipt.peek")).toHaveLength(1);
    },
  );

  it.each([
    [false, { code: "conflict", message: "Receipt args conflict" }],
    [true, { found: true, requestHash: "BAD" }],
    [true, { found: false, requestHash: hash }],
    [true, { found: "true", requestHash: hash }],
    [true, null],
  ])("fails closed on a lookup failure or malformed reply %j %j", async (ok, result) => {
    const f = fixture();
    const outcome = f.hook();
    await flush();
    f.reply(f.requests("receipt.peek")[0], result, ok);
    await expect(outcome).resolves.toMatchObject({ block: true });
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests("policy.evaluate")).toEqual([]);
    expect(f.requests("task.create")).toEqual([]);
  });

  it.each(["input", "name", "id"])("rechecks immutable %s after receipt lookup", async (field) => {
    const f = fixture();
    const event = f.event();
    const outcome = f.hook(event);
    await flush();
    if (field === "input") event.input = { objective: "other" };
    if (field === "name") event.toolName = "bash";
    if (field === "id") event.toolCallId = "other";
    f.reply(f.requests("receipt.peek")[0], { found: true, requestHash: hash });
    await expect(outcome).resolves.toMatchObject({ block: true });
    expect(f.requests("policy.evaluate")).toEqual([]);
  });

  it.each(["receipt", "normal"])(
    "rejects a changed execution argument in %s mode",
    async (mode) => {
      const f = fixture();
      await (mode === "receipt" ? receipt(f) : normal(f));
      await expect(f.execute(0, "call", { objective: "other" })).rejects.toThrow("does not match");
      expect(f.requests("task.create")).toEqual([]);
    },
  );

  it.each(
    ["receipt", "normal"].flatMap((mode) =>
      ["bindingId", "sessionId", "native", "attachment", "unsupported"].map((field) => [
        mode,
        field,
      ]),
    ),
  )("keeps a stale %s handoff restrictive across %s rotation", async (mode, field) => {
    const f = fixture(false);
    await (mode === "receipt" ? receipt(f) : normal(f));
    if (field === "native") {
      f.setNative("other");
      f.configure({ bindingId: "replacement" });
    } else if (field === "attachment") f.channel.onControlAttached();
    else if (field === "unsupported")
      f.configure({ bindingId: "replacement", features: ["agentRequests.v1"] });
    else f.configure({ [field]: "replacement" });
    await expect(f.execute()).rejects.toMatchObject({ code: "stale_control" });
    // Consuming a stale record does not let a second execution use the new controller.
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests("task.create")).toEqual([]);
  });

  it.each(["active", "required"])("rejects a missing handoff when %s", async (protection) => {
    const f = fixture(
      protection === "required",
      protection === "required" ? ["agentRequests.v1"] : undefined,
    );
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests()).toEqual([]);
  });

  it("preserves optional legacy unprotected execution", async () => {
    const f = fixture(false, ["agentRequests.v1"]);
    await expect(f.hook()).resolves.toBeUndefined();
    const outcome = f.execute();
    await flush();
    f.reply(f.requests("task.create")[0], { id: "legacy" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "legacy" } });
    expect(f.requests("receipt.peek")).toEqual([]);
  });

  it("cleans armed records on caller abort, never falls through after cleanup", async () => {
    const f = fixture();
    await receipt(f);
    f.controller.abort();
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests("task.create")).toEqual([]);
  });

  it("caps outstanding records at 64 without eviction or end-event capacity release", async () => {
    const f = fixture();
    for (let i = 0; i < 64; i++) await receipt(f, 0, `call-${i}`);
    await expect(f.hook(f.event(0, "overflow"))).resolves.toMatchObject({
      block: true,
      reason: "Too many active tool preflights",
    });
    expect(f.requests("receipt.peek")).toHaveLength(64);
    await expect(f.execute(0, "overflow")).rejects.toThrow("preflight is missing");
    const outcome = f.execute(0, "call-0");
    await flush();
    const replay = f.requests("task.create")[0];
    expect(replay.receiptReplay).toEqual({ requestHash: hash });
    await expect(f.hook(f.event(0, "overflow"))).resolves.toMatchObject({
      block: true,
      reason: "Too many active tool preflights",
    }); // The executing claim still occupies capacity while waiting for the network.
    f.reply(replay, { id: "original" });
    await outcome;
    f.end(0, "call-1");
    await receipt(f, 0, "overflow");
    // Completion freed only call-0. The ambiguous end did not free call-1.
    await expect(f.hook(f.event(0, "still-full"))).resolves.toMatchObject({
      block: true,
      terminate: true,
      reason: "Too many active tool preflights",
    });
    f.ctx.isIdle.mockReturnValue(true);
    f.settled();
    await receipt(f, 0, "after-idle");
  });

  it("does not share handoffs across methods, tool IDs or channels", async () => {
    const f = fixture();
    await receipt(f);
    await expect(f.execute(1)).rejects.toThrow("preflight is missing");
    await expect(f.execute(0, "other-call")).rejects.toThrow("preflight is missing");
    const other = fixture();
    await expect(other.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests("task.create")).toEqual([]);
    expect(other.requests()).toEqual([]);
  });

  it("bounds pending lookups too and releases every aborted reservation", async () => {
    const f = fixture();
    const outcomes = Array.from({ length: 64 }, (_, i) => f.hook(f.event(0, `pending-${i}`)));
    await flush();
    expect(f.requests("receipt.peek")).toHaveLength(64);
    await expect(f.hook(f.event(0, "overflow"))).resolves.toMatchObject({ block: true });
    f.controller.abort();
    for (const outcome of outcomes) await expect(outcome).resolves.toMatchObject({ block: true });
    f.ctx.signal = new AbortController().signal;
    await receipt(f, 0, "after-abort");
  });

  it("duplicate end cannot delete the original receipt replay or terminate its shared signal", async () => {
    const f = fixture();
    await receipt(f);
    await expect(f.hook()).resolves.toMatchObject({
      block: true,
      reason: "Tool preflight is already active",
      terminate: false,
    });
    expect(f.handlers.has("tool_execution_end")).toBe(false);
    f.end();
    expect(f.controller.signal.aborted).toBe(false);
    const outcome = f.execute();
    await flush();
    const replay = f.requests("task.create")[0];
    expect(replay.receiptReplay).toEqual({ requestHash: hash });
    f.reply(replay, { id: "original" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "original" } });
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests().map((r) => r.method)).toEqual(["receipt.peek", "task.create"]);
  });

  it("reserves synchronously while checking; duplicate/end cannot release the pending lookup", async () => {
    const f = fixture();
    const original = f.hook();
    await expect(f.hook()).resolves.toEqual({
      block: true,
      reason: "Tool preflight is already active",
      terminate: false,
    });
    f.end();
    await expect(f.execute()).rejects.toThrow("does not match");
    await flush();
    expect(f.requests("receipt.peek")).toHaveLength(1);
    f.reply(f.requests("receipt.peek")[0], { found: true, requestHash: hash });
    await expect(original).resolves.toBeUndefined();
    const outcome = f.execute();
    await flush();
    f.reply(f.requests("task.create")[0], { id: "original" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "original" } });
    expect(f.requests().map((r) => r.method)).toEqual(["receipt.peek", "task.create"]);
  });

  it("holds an executing claim against duplicate begin/consume, ambiguous ends and idle sweeps", async () => {
    const f = fixture();
    await receipt(f);
    const outcome = f.execute();
    await flush();
    await expect(f.hook()).resolves.toEqual({
      block: true,
      reason: "Tool preflight is already active",
      terminate: false,
    });
    await expect(f.execute()).rejects.toThrow("does not match");
    f.end();
    f.ctx.isIdle.mockReturnValue(true);
    f.settled();
    await expect(f.execute()).rejects.toThrow("does not match");
    f.reply(f.requests("task.create")[0], { id: "original" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "original" } });
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    expect(f.requests().map((r) => r.method)).toEqual(["receipt.peek", "task.create"]);
    await receipt(f); // execute-finally, not end/idle, released the key.
  });

  it.each(["receipt", "normal"])(
    "releases only the claimed %s execution on timeout",
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture();
      await (mode === "receipt" ? receipt(f) : normal(f));
      const outcome = f.execute();
      const rejected = expect(outcome).rejects.toMatchObject({ code: "timeout" });
      await flush();
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      await receipt(f);
    },
  );

  it("an old hook catch cannot delete a replacement begun immediately after abort", async () => {
    const f = fixture();
    const old = f.hook();
    await flush();
    f.controller.abort();
    f.ctx.signal = new AbortController().signal;
    const replacement = f.hook(); // before the old rejected await reaches its catch
    await expect(old).resolves.toMatchObject({ block: true, terminate: true });
    await flush();
    f.reply(f.requests("receipt.peek").at(-1), { found: true, requestHash: hash });
    await expect(replacement).resolves.toBeUndefined();
    const outcome = f.execute();
    await flush();
    const replay = f.requests("task.create")[0];
    expect(replay.receiptReplay).toEqual({ requestHash: hash });
    f.reply(replay, { id: "replacement" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "replacement" } });
  });

  it("an aborted adapter's old finally cannot delete its replacement", async () => {
    const f = fixture();
    await receipt(f);
    const old = f.execute();
    const rejected = expect(old).rejects.toMatchObject({ code: "conflict" });
    await flush();
    f.controller.abort();
    f.ctx.signal = new AbortController().signal;
    const replacement = f.hook(); // begin before old execute-finally runs
    await rejected;
    await flush();
    f.reply(f.requests("receipt.peek").at(-1), { found: true, requestHash: hash });
    await expect(replacement).resolves.toBeUndefined();
    const outcome = f.execute();
    await flush();
    const replay = f.requests("task.create").at(-1);
    expect(replay.receiptReplay).toEqual({ requestHash: hash });
    f.reply(replay, { id: "replacement" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "replacement" } });
    expect(f.requests("policy.evaluate")).toEqual([]);
  });

  it("late owner abort/release/remember cannot touch a new same-key record", () => {
    const f = fixture();
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const first = beginAgentToolPreflight(
      f.channel,
      "task.create",
      "call",
      inputs[0],
      controller.signal,
    );
    expect(Object.isFrozen(first)).toBe(true);
    const delayedAbort = listen.mock.calls[0][1] as () => void;
    expect(releaseAgentToolPreflight(f.channel, first)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    const nextController = new AbortController();
    const next = beginAgentToolPreflight(
      f.channel,
      "task.create",
      "call",
      inputs[0],
      nextController.signal,
    );
    expect(next.token).not.toBe(first.token);
    delayedAbort();
    controller.abort();
    expect(releaseAgentToolPreflight(f.channel, first)).toBe(false);
    const preflight = {
      method: "task.create" as const,
      toolCallId: "call",
      mode: "receipt" as const,
      requestHash: hash,
      binding: f.channel.snapshot().configuration!,
    };
    expect(() => rememberAgentToolPreflight(f.channel, first, preflight)).toThrow("missing");
    rememberAgentToolPreflight(f.channel, next, preflight);
    expect(() => rememberAgentToolPreflight(f.channel, next, preflight)).toThrow("finalized");
    const claim = consumeAgentToolPreflight(f.channel, "task.create", "call", inputs[0]);
    expect(claim?.owner).toBe(next);
    expect(claim?.preflight).toMatchObject({ mode: "receipt", requestHash: hash });
    expect(releaseAgentToolPreflight(f.channel, first)).toBe(false); // delayed execute-finally
    expect(() => consumeAgentToolPreflight(f.channel, "task.create", "call", inputs[0])).toThrow(
      "does not match",
    );
    nextController.abort();
    expect(releaseAgentToolPreflight(f.channel, next)).toBe(false);
  });

  it("duplicate/capacity begin owns nothing and does not alter existing abort listeners", () => {
    const f = fixture();
    const controller = new AbortController();
    const listen = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const owner = beginAgentToolPreflight(
      f.channel,
      "task.create",
      "call",
      inputs[0],
      controller.signal,
    );
    expect(() =>
      beginAgentToolPreflight(f.channel, "task.create", "call", {}, controller.signal),
    ).toThrow(DuplicateAgentToolPreflightError);
    for (let i = 1; i < 64; i++)
      beginAgentToolPreflight(f.channel, "task.create", `call-${i}`, {}, controller.signal);
    expect(() =>
      beginAgentToolPreflight(f.channel, "task.create", "overflow", {}, controller.signal),
    ).toThrow("Too many");
    expect(listen).toHaveBeenCalledTimes(64);
    expect(remove).not.toHaveBeenCalled();
    controller.abort();
    expect(remove).toHaveBeenCalledTimes(64);
    expect(releaseAgentToolPreflight(f.channel, owner)).toBe(false);
    expect(beginAgentToolPreflight(f.channel, "task.create", "overflow", {}).token).toBeTypeOf(
      "symbol",
    );
  });

  it("sweeps abandoned armed/checking rows only at proven final idle, scoped to the channel", async () => {
    const f = fixture();
    const other = fixture();
    await receipt(f);
    await receipt(other);
    const pending = f.hook(f.event(0, "checking"));
    await flush();
    f.end(); // e.g. a later trusted hook blocked this call
    f.settled(); // busy
    await expect(f.hook()).resolves.toMatchObject({ terminate: false });
    f.handlers.get("agent_settled")!({}, {}); // missing idle API is not proof
    await expect(f.hook()).resolves.toMatchObject({ terminate: false });
    f.ctx.isIdle.mockReturnValue(true);
    f.settled();
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    const replacement = f.hook(f.event(0, "checking"));
    await flush();
    // The swept old lookup arriving late must neither arm nor delete the replacement.
    const peeks = f.requests("receipt.peek");
    f.reply(peeks[1], { found: true, requestHash: hash });
    await expect(pending).resolves.toMatchObject({ block: true });
    f.reply(peeks[2], { found: true, requestHash: hash });
    await expect(replacement).resolves.toBeUndefined();
    const outcome = other.execute();
    await flush();
    other.reply(other.requests("task.create")[0], { id: "other-channel" });
    await expect(outcome).resolves.toMatchObject({ details: { id: "other-channel" } });
    expect(f.requests("task.create")).toEqual([]);
  });

  it("genuine teardown clears only its own channel's records", async () => {
    const f = fixture();
    const other = fixture();
    await receipt(f);
    await receipt(other);
    f.handlers.get("session_shutdown")!();
    await expect(f.execute()).rejects.toThrow("preflight is missing");
    await expect(other.hook()).resolves.toMatchObject({ terminate: false });
  });

  it("shares the initial 30-second deadline with lookup and normal evaluation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const outcome = f.hook();
    await flush();
    await vi.advanceTimersByTimeAsync(29000);
    f.reply(f.requests("receipt.peek")[0], { found: false });
    await flush();
    const evaluation = f.requests("policy.evaluate")[0];
    expect(Date.parse(evaluation.deadlineAt) - Date.now()).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toMatchObject({
      block: true,
      reason: "Coordinator communication timed out",
    });
  });

  it("rejects receiptReplay on non-tool methods and validates its hash before sending", async () => {
    const f = fixture();
    for (const method of [
      "receipt.peek",
      "policy.evaluate",
      "policy.status",
      "policy.cancel",
    ] as const) {
      await expect(
        f.channel.request(method, {}, { toolCallId: "call", receiptReplay: { requestHash: hash } }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(
      f.channel.request("task.create", {}, { receiptReplay: { requestHash: "bad" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.channel.request("receipt.peek", {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.requests()).toEqual([]);
  });
});
