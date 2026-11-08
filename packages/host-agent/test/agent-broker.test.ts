import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { ManagedSession } from "@switchyard/pi-runtime";
import { type AgentRequestFrame, SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  BridgeAgentRequest,
  BridgeAgentResult,
  BridgeCommand,
  BridgeHello,
  BridgeRequests,
} from "../../pi-runtime/src/bridge-wire.js";
import {
  AgentBroker,
  type AgentBrokerConfiguration,
  type AgentBrokerHello,
  type AgentBrokerOptions,
  type AgentBrokerRequest,
  type AgentBrokerSession,
} from "../src/agent-broker.js";
import { HostDb } from "../src/db/index.js";
import { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";

const FEATURES = ["agentRequests.v1", "policies.v1"];
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function hello(overrides: Partial<AgentBrokerHello> = {}): AgentBrokerHello {
  return {
    type: "agent.hello",
    version: 1,
    runtimeId: "runtime1",
    nativeSessionId: "native1",
    sessionFile: null,
    pid: 123,
    mode: "rpc",
    capabilities: {
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    },
    context: { humanInputId: "human1", causalMessageId: "message1" },
    ...overrides,
  };
}
function bindResult(
  sessionId: string,
  nativeSessionId: string,
  runtimeId: string,
  policyRequired = false,
  features = FEATURES,
) {
  return {
    version: 1 as const,
    sessionId,
    nativeSessionId,
    runtimeId,
    features: [...features],
    policyRequired,
    sessionUrl: features.includes("policies.v1")
      ? `https://switchyard.example/code/${encodeURIComponent(sessionId)}`
      : null,
  };
}
function configured(configuration: AgentBrokerConfiguration, report = hello()) {
  const enabled = configuration.features.includes("agentRequests.v1");
  const active =
    enabled && configuration.features.includes("policies.v1") && report.capabilities.toolPolicy;
  return {
    configured: true,
    agentTools: enabled && report.capabilities.agentTools,
    messageDelivery:
      enabled && report.capabilities.messageDelivery && report.capabilities.editorDraftGuard,
    policyRequired: configuration.policyRequired,
    policyState: active ? "active" : "unsupported",
    policyPhases: active ? ["tool_call", "request"] : [],
  };
}

function fixture(
  options: {
    required?: boolean;
    features?: string[];
    connected?: boolean;
    timeoutMs?: number;
  } = {},
) {
  let connected = options.connected ?? true;
  let features = options.features ?? FEATURES;
  const events: CoordinatorLink["events"] = new EventEmitter();
  const requestAgent = vi.fn<CoordinatorLink["requestAgent"]>(
    async (sessionId, native, runtime, method, args) =>
      method === "session.bind"
        ? bindResult(
            sessionId,
            native,
            runtime,
            (args as { policyRequired: boolean }).policyRequired,
            features,
          )
        : { done: true },
  );
  const link = {
    get connected() {
      return connected;
    },
    get negotiatedFeatures() {
      return new Set(features);
    },
    events,
    requestAgent,
  } satisfies AgentBrokerOptions["link"];
  let report = hello();
  const session = {
    sessionId: "ses_one",
    mode: "rpc" as const,
    policyRequired: options.required ?? false,
    configureAgent: vi.fn<AgentBrokerSession["configureAgent"]>(async (config) =>
      configured(config, report),
    ),
    bridgeRequest: vi.fn<AgentBrokerSession["bridgeRequest"]>(async () => undefined as never),
    replyAgent: vi.fn<AgentBrokerSession["replyAgent"]>(),
    setPolicyWaiting: vi.fn<AgentBrokerSession["setPolicyWaiting"]>(),
    onState: vi.fn<NonNullable<AgentBrokerSession["onState"]>>(),
  };
  const onError = vi.fn();
  const broker = new AgentBroker({ link, timeoutMs: options.timeoutMs, onError });
  cleanup.push(() => broker.close());
  const handle = broker.attach(session);
  return {
    session,
    link,
    broker,
    handle,
    onError,
    async announce(next = report) {
      report = next;
      await handle.hello(next);
    },
    disconnect() {
      connected = false;
      events.emit("disconnected", { code: 1006, reason: "test" });
    },
    welcome(next = features) {
      features = next;
      connected = true;
      events.emit("welcome", {
        coordinatorVersion: "test",
        ackedHostSeq: 0,
        features,
      });
    },
    frame(overrides: Partial<AgentBrokerRequest> = {}): AgentBrokerRequest {
      const config = handle.snapshot().configuration!;
      return {
        type: "agent.request",
        requestId: randomUUID(),
        sessionId: session.sessionId,
        nativeSessionId: report.nativeSessionId,
        runtimeId: report.runtimeId,
        bindingId: config.bindingId,
        method: "task.create",
        toolCallId: "tool1",
        context: { humanInputId: "human2", causalMessageId: "message2" },
        args: { objective: "A task" },
        ...overrides,
      };
    },
  };
}

// Compile-time adapter contract: these are actual ManagedSession methods, not a fake variant.
// The supervisor adds mode/launch policyRequired and owns event/state persistence wiring.
function managedAdapter(session: ManagedSession): AgentBrokerSession {
  return {
    sessionId: session.sessionId,
    mode: "rpc",
    policyRequired: true,
    configureAgent: (configuration, options) => session.configureAgent(configuration, options),
    bridgeRequest: (method, args, options) => session.bridgeRequest(method, args, options),
    replyAgent: (frame) => session.replyAgent(frame),
    setPolicyWaiting: (id, waiting) => session.setPolicyWaiting(id, waiting),
  };
}
void managedAdapter;

describe("AgentBroker binding and configuration", () => {
  it("binds actual hello identity before configure and waits for its receipt before protection/readiness", async () => {
    const f = fixture({ required: true });
    const receipt = deferred<unknown>();
    f.session.configureAgent.mockReturnValue(receipt.promise);
    const announced = f.announce();
    let ready = false;
    const startup = f.handle.ready().then((value) => {
      ready = true;
      return value;
    });
    await flush();
    expect(f.link.requestAgent).toHaveBeenCalledExactlyOnceWith(
      "ses_one",
      "native1",
      "runtime1",
      "session.bind",
      {
        version: 1,
        sessionFile: null,
        mode: "rpc",
        capabilities: hello().capabilities,
        policyRequired: true,
      },
      expect.objectContaining({
        context: hello().context,
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    const config = f.session.configureAgent.mock.calls[0][0];
    expect(config).toEqual({
      ...bindResult("ses_one", "native1", "runtime1", true),
      coordinatorConnected: true,
      bindingId: expect.any(String),
    });
    expect(config.bindingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.handle.snapshot().configuration).toBeNull();
    expect(f.handle.snapshot().bridge?.policyState).toBe("initializing");
    expect(ready).toBe(false);
    receipt.resolve(configured(config));
    await announced;
    expect(await startup).toEqual(config);
    expect(f.handle.snapshot().bridge).toMatchObject({
      nativeSessionId: "native1",
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    });
    expect(ready).toBe(true);
  });

  it.each([
    { bound: true },
    { ...bindResult("other", "native1", "runtime1") },
    { ...bindResult("ses_one", "substituted", "runtime1") },
    { ...bindResult("ses_one", "native1", "substituted") },
    {
      ...bindResult("ses_one", "native1", "runtime1"),
      bindingId: "coordinator-must-not-choose-this",
    },
    { ...bindResult("ses_one", "native1", "runtime1"), policyRequired: true },
    { ...bindResult("ses_one", "native1", "runtime1"), features: [...FEATURES, "invented.v1"] },
    { ...bindResult("ses_one", "native1", "runtime1"), features: ["policies.v1"] },
    { ...bindResult("ses_one", "native1", "runtime1"), features: [...FEATURES, "policies.v1"] },
    { ...bindResult("ses_one", "native1", "runtime1"), sessionUrl: null },
  ])("rejects malformed/substituted session.bind results: %j", async (result) => {
    const f = fixture();
    f.link.requestAgent.mockResolvedValue(result);
    await expect(f.announce()).rejects.toBeInstanceOf(SwitchyardError);
    expect(f.session.configureAgent).not.toHaveBeenCalled();
    expect(f.handle.snapshot().bridge?.policyState).not.toBe("active");
    await expect(f.handle.ready()).rejects.toBeInstanceOf(SwitchyardError);
  });

  it.each([
    { configured: true },
    {
      ...configured({
        ...bindResult("ses_one", "native1", "runtime1", true),
        bindingId: "b",
        coordinatorConnected: true,
      }),
      policyRequired: false,
    },
    {
      ...configured({
        ...bindResult("ses_one", "native1", "runtime1", true),
        bindingId: "b",
        coordinatorConnected: true,
      }),
      policyState: "unsupported",
    },
    {
      ...configured({
        ...bindResult("ses_one", "native1", "runtime1", true),
        bindingId: "b",
        coordinatorConnected: true,
      }),
      policyPhases: ["tool_call"],
    },
    {
      ...configured({
        ...bindResult("ses_one", "native1", "runtime1", true),
        bindingId: "b",
        coordinatorConnected: true,
      }),
      agentTools: false,
    },
  ])("does not treat configured:true as active protection: %j", async (receipt) => {
    const f = fixture({ required: true });
    f.session.configureAgent.mockResolvedValue(receipt);
    await expect(f.announce()).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.handle.snapshot().configuration).toBeNull();
  });

  it("explicitly configures an old coordinator disabled without emitting session.bind or agent frames", async () => {
    const f = fixture({ features: [] });
    await f.announce();
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    expect(f.session.configureAgent.mock.calls[0][0]).toMatchObject({
      features: [],
      sessionUrl: null,
      coordinatorConnected: true,
    });
    expect(f.handle.snapshot().bridge).toMatchObject({
      agentTools: false,
      messageDelivery: false,
      policyState: "unsupported",
      policyPhases: [],
    });
    await expect(f.handle.ready()).rejects.toMatchObject({ code: "unsupported_capability" });
    await f.handle.request(f.frame());
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "unsupported_capability" }),
      }),
    );
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    // Native human prompts remain usable; this local marker requires no new coordinator API.
    await f.handle.humanInput();
    expect(f.session.bridgeRequest).toHaveBeenCalledWith(
      "input.human",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects required unsupported launches only AFTER the successful disabled configure receipt", async () => {
    const f = fixture({ required: true, features: [] });
    await expect(f.announce()).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(f.session.configureAgent).toHaveBeenCalledOnce();
    expect(f.handle.snapshot().configuration?.policyRequired).toBe(true);
    expect(f.handle.snapshot().bridge?.policyState).toBe("unsupported");
  });

  it("enables delivery only with the actual editor guard and refuses uninstalled policy support", async () => {
    const f = fixture({ features: ["agentRequests.v1"] });
    await f.announce(
      hello({
        mode: "rpc",
        capabilities: { ...hello().capabilities, editorDraftGuard: false, toolPolicy: false },
      }),
    );
    expect(f.handle.snapshot().bridge).toMatchObject({
      agentTools: true,
      messageDelivery: false,
      policyState: "unsupported",
    });
    const g = fixture();
    await expect(
      g.announce(hello({ capabilities: { ...hello().capabilities, toolPolicy: false } })),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects substituted modes and projected bridge state instead of an actual hello", async () => {
    const f = fixture();
    await expect(f.announce(hello({ mode: "terminal" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      f.handle.hello({ version: 1, runtimeId: "runtime1", policyState: "active" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.link.requestAgent).not.toHaveBeenCalled();
  });
});

describe("AgentBroker direct request lane", () => {
  it("uses the owning session, strips bindingId, copies trusted branch context, and restores local correlation", async () => {
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockClear();
    const frame = f.frame({
      args: {
        objective: "A task",
        context: { humanInputId: "spoof", causalMessageId: "spoof" },
        hostId: "hint",
      },
    });
    await f.handle.request(frame);
    expect(f.link.requestAgent).toHaveBeenCalledExactlyOnceWith(
      "ses_one",
      "native1",
      "runtime1",
      "task.create",
      frame.args,
      expect.objectContaining({ toolCallId: "tool1", context: frame.context, timeoutMs: 30_000 }),
    );
    expect(f.link.requestAgent.mock.calls[0][5]).not.toHaveProperty("bindingId");
    expect(f.session.replyAgent).toHaveBeenCalledExactlyOnceWith({
      type: "agent.result",
      requestId: frame.requestId,
      runtimeId: frame.runtimeId,
      bindingId: frame.bindingId,
      ok: true,
      result: { done: true },
    });
    expect(BridgeAgentResult.safeParse(f.session.replyAgent.mock.calls[0][0]).success).toBe(true);
  });

  it.each([
    { sessionId: "ses_other" },
    { runtimeId: "other" },
    { nativeSessionId: "other" },
    { bindingId: "old-binding" },
    { method: "session.bind" as const },
    { toolCallId: undefined },
  ])("rejects identity/binding/broker-only substitutions: %j", async (change) => {
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockClear();
    await f.handle.request(f.frame(change));
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    expect(f.session.replyAgent).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("rejects unknown methods and oversized UTF-8 records without closing the healthy lane", async () => {
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockClear();
    await f.handle.request({ ...f.frame(), method: "unknown.method" });
    await f.handle.request(f.frame({ args: { objective: "é".repeat(70_000) } }));
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    expect(
      f.session.replyAgent.mock.calls.map(([reply]) => (reply.ok ? "success" : reply.error.code)),
    ).toEqual(["invalid_request", "invalid_request"]);
    await f.handle.request(f.frame());
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
  });

  it("forwards simultaneous requests without a prompt/session queue and preserves tool identity on explicit retry", async () => {
    const f = fixture();
    await f.announce();
    const first = deferred<unknown>();
    f.link.requestAgent.mockImplementationOnce(() => first.promise);
    const a = f.frame();
    const waiting = f.handle.request(a);
    await f.handle.request(f.frame({ method: "inbox.read", toolCallId: undefined }));
    expect(f.session.replyAgent).toHaveBeenCalledOnce();
    expect(f.session.replyAgent.mock.calls[0][0].ok).toBe(true);
    first.reject(new SwitchyardError("timeout", "Timed out"));
    await waiting;
    const retry = f.frame();
    await f.handle.request(retry);
    expect(retry.requestId).not.toBe(a.requestId);
    expect(
      f.link.requestAgent.mock.calls.slice(1).map((call) => [call[3], call[5]?.toolCallId]),
    ).toEqual([
      ["task.create", "tool1"],
      ["inbox.read", undefined],
      ["task.create", "tool1"],
    ]);
  });

  it("never converts coordinator errors to successes and does not leak unknown exception details", async () => {
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockRejectedValueOnce(
      new SwitchyardError("forbidden", "Denied", { rule: "r" }),
    );
    await f.handle.request(f.frame());
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: { code: "forbidden", message: "Denied", details: { rule: "r" } },
      }),
    );
    f.link.requestAgent.mockRejectedValueOnce(new Error("secret credential"));
    await f.handle.request(f.frame());
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: { code: "internal", message: "Agent broker request failed" },
      }),
    );
  });

  it("tracks ASK across healthy long polls and clears waiting in terminal/error/cancel paths", async () => {
    const f = fixture();
    await f.announce();
    const ask = async () => {
      f.link.requestAgent.mockResolvedValueOnce({
        verdict: "ASK",
        decisionId: "d1",
        interactionId: "i1",
        interactionUrl: "https://switchyard.example/code/ses_one",
      });
      await f.handle.request(f.frame({ method: "policy.evaluate" }));
    };
    await ask();
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", true);
    const args = { decisionId: "d1", waitMs: 25_000 };
    f.link.requestAgent.mockResolvedValueOnce({ state: "pending" });
    await f.handle.request(f.frame({ method: "policy.status", args }));
    expect(f.session.setPolicyWaiting).toHaveBeenCalledTimes(1);
    f.link.requestAgent.mockResolvedValueOnce({ state: "allowed" });
    await f.handle.request(f.frame({ method: "policy.status", args }));
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", false);
    await ask();
    f.link.requestAgent.mockRejectedValueOnce(new SwitchyardError("host_unreachable", "Gone"));
    await f.handle.request(f.frame({ method: "policy.status", args }));
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", false);
    await ask();
    f.link.requestAgent.mockResolvedValueOnce({ state: "canceled" });
    await f.handle.request(f.frame({ method: "policy.cancel", args: { decisionId: "d1" } }));
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", false);
  });

  it("keeps healthy policy ASK waiting beyond 30 seconds, using separate 25-second status polls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockResolvedValueOnce({
      verdict: "ASK",
      decisionId: "d1",
      interactionId: "i1",
      interactionUrl: "https://switchyard.example/code/ses_one",
    });
    await f.handle.request(f.frame({ method: "policy.evaluate" }));
    for (let i = 0; i < 3; i++) {
      const poll = deferred<unknown>();
      f.link.requestAgent.mockReturnValueOnce(poll.promise);
      const request = f.handle.request(
        f.frame({ method: "policy.status", args: { decisionId: "d1", waitMs: 25_000 } }),
      );
      await vi.advanceTimersByTimeAsync(25_000);
      poll.resolve({ state: "pending" });
      await request;
    }
    expect(f.session.setPolicyWaiting.mock.calls).toEqual([["d1", true]]);
    f.link.requestAgent.mockResolvedValueOnce({ state: "denied", reason: "No" });
    await f.handle.request(
      f.frame({ method: "policy.status", args: { decisionId: "d1", waitMs: 25_000 } }),
    );
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", false);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: true, result: { state: "denied", reason: "No" } }),
    );
  });

  it("bounds concurrent forwarding and cancels every in-flight request on exit", async () => {
    const f = fixture();
    await f.announce();
    const signals: AbortSignal[] = [];
    f.link.requestAgent.mockImplementation(
      (_session, _native, _runtime, _method, _args, options) =>
        new Promise((_resolve, reject) => {
          signals.push(options!.signal!);
          options!.signal!.addEventListener(
            "abort",
            () => reject(new SwitchyardError("host_unreachable", "Stopped")),
            { once: true },
          );
        }),
    );
    const pending = Array.from({ length: 256 }, () => f.handle.request(f.frame()));
    await f.handle.request(f.frame());
    expect(signals).toHaveLength(256);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "rate_limited" }),
      }),
    );
    f.handle.close();
    await Promise.all(pending);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.session.replyAgent).toHaveBeenCalledOnce();
  });

  it("clears outstanding policy waiting on controller loss/exit without waiting behind the blocked turn", async () => {
    const f = fixture();
    await f.announce();
    f.link.requestAgent.mockResolvedValueOnce({ verdict: "ASK", decisionId: "d1" });
    await f.handle.request(f.frame({ method: "policy.evaluate" }));
    f.handle.lost();
    expect(f.session.setPolicyWaiting).toHaveBeenLastCalledWith("d1", false);
    expect(f.handle.snapshot().bridge?.policyState).toBe("lost");
    f.handle.close();
    expect(f.link.events.listenerCount("welcome")).toBe(1); // broker-level, not a leak per session
    f.broker.close();
    expect(f.link.events.listenerCount("welcome")).toBe(0);
  });
});

describe("AgentBroker reconnect, native switch and human input", () => {
  it("starts before welcome, never puts session.bind into an outbox, and waits for negotiation", async () => {
    const f = fixture({ connected: false });
    const announced = f.announce();
    await flush();
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    expect(f.session.configureAgent).not.toHaveBeenCalled();
    f.welcome();
    await announced;
    expect(f.link.requestAgent).toHaveBeenCalledOnce();
  });

  it("signals disconnection, fails requests closed, rebinds centrally, then resumes the SAME local fence", async () => {
    const f = fixture();
    await f.announce();
    const before = f.handle.snapshot().configuration!;
    f.disconnect();
    expect(f.session.bridgeRequest).toHaveBeenLastCalledWith("connection.update", {
      connected: false,
    });
    expect(f.handle.snapshot().bridge?.policyState).toBe("lost");
    await f.handle.request(f.frame());
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "host_unreachable" }),
      }),
    );
    f.welcome();
    await flush();
    expect(f.link.requestAgent.mock.calls.map((call) => call[3])).toEqual([
      "session.bind",
      "session.bind",
    ]);
    expect(f.session.configureAgent).toHaveBeenCalledOnce();
    expect(f.session.bridgeRequest).toHaveBeenLastCalledWith(
      "connection.update",
      { connected: true },
      expect.any(Object),
    );
    expect((await f.handle.ready()).bindingId).toBe(before.bindingId);
    expect(f.handle.snapshot().bridge?.policyState).toBe("active");
  });

  it("retries a startup bind after connection loss within the original fixed deadline", async () => {
    vi.useFakeTimers();
    const f = fixture({ required: true });
    const first = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(first.promise);
    const announced = f.announce();
    await vi.advanceTimersByTimeAsync(10_000);
    f.disconnect();
    first.reject(new SwitchyardError("host_unreachable", "Disconnected"));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    f.welcome();
    await announced;
    expect(f.link.requestAgent).toHaveBeenCalledTimes(2);
    expect(f.link.requestAgent.mock.calls[1][5]?.timeoutMs).toBe(15_000);
    expect(f.handle.snapshot().bridge?.policyState).toBe("active");
  });

  it("ignores a late reply from a request canceled by coordinator loss, even after same-binding reconnect", async () => {
    const f = fixture();
    await f.announce();
    const late = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(late.promise);
    const request = f.handle.request(f.frame());
    f.disconnect();
    f.welcome();
    await flush();
    late.resolve({ done: "late" });
    await request;
    expect(f.session.replyAgent).not.toHaveBeenCalled();
  });

  it("rotates and disables on reconnect to an old coordinator, preserving the required latch", async () => {
    const f = fixture({ required: true });
    await f.announce();
    const bindingId = f.handle.snapshot().configuration!.bindingId;
    f.disconnect();
    f.welcome([]);
    await flush();
    expect(f.session.configureAgent).toHaveBeenCalledTimes(2);
    expect(f.handle.snapshot().configuration).toMatchObject({ features: [], policyRequired: true });
    expect(f.handle.snapshot().configuration?.bindingId).not.toBe(bindingId);
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "unsupported_capability" }),
      "ses_one",
    );
  });

  it("fresh-configures reattachment and native switches, aborting old requests and ignoring their late results", async () => {
    const f = fixture({ required: true });
    await f.announce();
    const first = f.frame();
    const pending = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(pending.promise);
    const request = f.handle.request(first);
    const signal = f.link.requestAgent.mock.calls.at(-1)![5]!.signal!;
    await f.announce(); // same extension, new controller -> new binding
    expect(signal.aborted).toBe(true);
    expect(f.handle.snapshot().configuration?.bindingId).not.toBe(first.bindingId);
    pending.resolve({ done: "obsolete" });
    await request;
    expect(f.session.replyAgent).not.toHaveBeenCalled();
    await f.announce(hello({ nativeSessionId: "native2", sessionFile: "/native2.jsonl" }));
    expect(f.link.requestAgent).toHaveBeenLastCalledWith(
      "ses_one",
      "native2",
      "runtime1",
      "session.bind",
      expect.objectContaining({ sessionFile: "/native2.jsonl", policyRequired: true }),
      expect.any(Object),
    );
    await f.handle.request(first);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, bindingId: first.bindingId }),
    );
    f.handle.lost();
    const count = f.link.requestAgent.mock.calls.length;
    f.welcome();
    await flush();
    expect(f.link.requestAgent).toHaveBeenCalledTimes(count); // requires fresh actual hello
  });

  it("fences a replaced owning ManagedSession even if it has the same Switchyard sessionId", async () => {
    const f = fixture();
    await f.announce();
    const frame = f.frame();
    const late = deferred<unknown>();
    f.link.requestAgent.mockReturnValueOnce(late.promise);
    const pending = f.handle.request(frame);
    f.broker.attach({ ...f.session, replyAgent: vi.fn() });
    late.resolve({ done: "old" });
    await pending;
    expect(f.session.replyAgent).not.toHaveBeenCalled();
    expect(f.handle.snapshot().configuration).toBeNull();
  });

  it("awaits a fresh human marker receipt before releasing a prompt, and preserves trusted causality on rebind", async () => {
    const f = fixture();
    await f.announce();
    const marker = deferred<unknown>();
    f.session.bridgeRequest.mockReturnValueOnce(marker.promise as Promise<never>);
    let promptReleased = false;
    const prompt = f.handle.humanInput().then((id) => {
      promptReleased = true;
      return id;
    });
    await flush();
    expect(promptReleased).toBe(false);
    const [method, args] = f.session.bridgeRequest.mock.calls[0];
    expect(method).toBe("input.human");
    expect(args).toEqual({ humanInputId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    marker.resolve({ recorded: true });
    const id = await prompt;
    expect(promptReleased).toBe(true);
    expect(id).toBe((args as { humanInputId: string }).humanInputId);
    f.disconnect();
    f.welcome();
    await flush();
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.context).toEqual({
      humanInputId: id,
      causalMessageId: null,
    });
    await f.handle.request(
      f.frame({ context: { humanInputId: id, causalMessageId: "delivered-after-human" } }),
    );
    f.disconnect();
    f.welcome();
    await flush();
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.context).toEqual({
      humanInputId: id,
      causalMessageId: "delivered-after-human",
    });
    await f.announce(
      hello({ context: { humanInputId: id, causalMessageId: "reloaded-active-branch" } }),
    );
    expect(f.link.requestAgent.mock.calls.at(-1)![5]?.context).toEqual({
      humanInputId: id,
      causalMessageId: "reloaded-active-branch",
    });
  });

  it("caps startup/readiness at 30 seconds and never releases a required prompt without hello/receipt", async () => {
    vi.useFakeTimers();
    const f = fixture({ required: true, timeoutMs: 90_000 });
    expect(f.broker.timeoutMs).toBe(30_000);
    const ready = expect(f.handle.ready({ timeoutMs: 90_000 })).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await ready;
    const stuck = deferred<unknown>();
    f.session.configureAgent.mockReturnValue(stuck.promise);
    const announcement = expect(f.announce()).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await announcement;
    expect(f.handle.snapshot().configuration).toBeNull();
    expect(f.handle.snapshot().bridge?.policyState).not.toBe("active");
    stuck.resolve({ configured: true });
    await flush();
    expect(f.handle.snapshot().configuration).toBeNull();
  });

  it("cancels readiness on caller abort/close without leaking event waiters", async () => {
    const f = fixture({ connected: false });
    const controller = new AbortController();
    const ready = expect(f.handle.ready({ signal: controller.signal })).rejects.toThrow("Canceled");
    controller.abort(new Error("Canceled"));
    await ready;
    const closed = expect(f.handle.ready()).rejects.toMatchObject({ code: "stale_control" });
    f.handle.close();
    await closed;
  });
});

describe("AgentBroker real CoordinatorLink and A.1 local envelope contract", () => {
  it("uses ephemeral global frames and actual identity-fenced local commands/receipts on reconnect", async () => {
    const db = new HostDb(":memory:");
    db.migrate();
    cleanup.push(() => db.close());
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanup.push(async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const globalFrames: AgentRequestFrame[] = [];
    const connections = new EventEmitter<{ hello: [WebSocket] }>();
    server.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "hello") {
          connections.emit("hello", ws);
          return;
        }
        if (frame.type !== "agent.request") return;
        globalFrames.push(frame);
        ws.send(
          JSON.stringify({
            type: "agent.result",
            requestId: frame.requestId,
            runtimeId: frame.runtimeId,
            ok: true,
            result:
              frame.method === "session.bind"
                ? bindResult(
                    frame.sessionId,
                    frame.nativeSessionId,
                    frame.runtimeId,
                    frame.args.policyRequired,
                  )
                : { created: "task1" },
          }),
        );
      }),
    );
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
        throw new Error("Agent frames must bypass CommandRouter");
      },
      log: silentLogger(),
      backoffMs: [1],
    });
    cleanup.push(() => link.stop());
    const broker = new AgentBroker({ link });
    cleanup.push(() => broker.close());
    const local = new BridgeRequests();
    const report = BridgeHello.parse(JSON.parse(JSON.stringify(hello())));
    local.setHello(report);
    const commands: unknown[] = [];
    const replies: unknown[] = [];
    const adapter: AgentBrokerSession = {
      sessionId: "ses/one",
      mode: "rpc",
      policyRequired: true,
      configureAgent: (config, options) => local.request("configure", config, send, options),
      bridgeRequest: (method, args, options) => local.request(method, args, send, options),
      replyAgent: (frame) => {
        replies.push(BridgeAgentResult.parse(frame));
      },
      setPolicyWaiting: vi.fn(),
    };
    async function send(record: unknown) {
      const command = BridgeCommand.parse(JSON.parse(JSON.stringify(record)));
      commands.push(command);
      local.receive({
        type: "bridge.receipt",
        requestId: command.requestId,
        runtimeId: command.runtimeId,
        nativeSessionId: command.nativeSessionId,
        bindingId: command.bindingId,
        ok: true,
        result: command.method === "configure" ? configured(command.args, report) : {},
      });
    }
    const handle = broker.attach(adapter);
    const announcement = handle.hello(report);
    const welcomed = new Promise<void>((resolve) => link.events.once("welcome", () => resolve()));
    connections.once("hello", (ws) =>
      ws.send(
        JSON.stringify({
          type: "welcome",
          coordinatorVersion: "test",
          ackedHostSeq: 0,
          features: FEATURES,
        }),
      ),
    );
    link.start();
    await welcomed;
    await announcement;
    const config = await handle.ready();
    expect(globalFrames[0]).toMatchObject({
      sessionId: "ses/one",
      method: "session.bind",
      nativeSessionId: "native1",
      context: report.context,
    });
    expect(globalFrames[0]).not.toHaveProperty("bindingId");
    expect(globalFrames[0]).not.toHaveProperty("toolCallId");
    expect(commands[0]).toMatchObject({
      type: "bridge.command",
      method: "configure",
      runtimeId: config.runtimeId,
      nativeSessionId: config.nativeSessionId,
      bindingId: config.bindingId,
      args: config,
    });
    const frame: AgentBrokerRequest = {
      type: "agent.request",
      requestId: "local-tool",
      sessionId: "ses/one",
      nativeSessionId: config.nativeSessionId,
      runtimeId: config.runtimeId,
      bindingId: config.bindingId,
      method: "task.create",
      toolCallId: "logical-tool",
      context: { humanInputId: "human2", causalMessageId: null },
      args: { objective: "Task" },
    };
    expect(local.accepts(frame)).toBe(true);
    await handle.request(BridgeAgentRequest.parse(JSON.parse(JSON.stringify(frame))));
    expect(globalFrames[1].requestId).not.toBe(frame.requestId);
    expect(globalFrames[1]).toMatchObject({ toolCallId: "logical-tool", context: frame.context });
    expect(globalFrames[1]).not.toHaveProperty("bindingId");
    expect(replies).toEqual([
      {
        type: "agent.result",
        requestId: "local-tool",
        runtimeId: config.runtimeId,
        bindingId: config.bindingId,
        ok: true,
        result: { created: "task1" },
      },
    ]);
    expect(link.pending()).toEqual([]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox")?.count).toBe(0);
    const disconnected = new Promise<void>((resolve) =>
      link.events.once("disconnected", () => resolve()),
    );
    const nextHello = new Promise<WebSocket>((resolve) => connections.once("hello", resolve));
    link.dropConnection();
    await disconnected;
    const ws = await nextHello;
    const nextWelcome = new Promise<void>((resolve) =>
      link.events.once("welcome", () => resolve()),
    );
    ws.send(
      JSON.stringify({
        type: "welcome",
        coordinatorVersion: "test",
        ackedHostSeq: 0,
        features: FEATURES,
      }),
    );
    await nextWelcome;
    expect((await handle.ready()).bindingId).toBe(config.bindingId);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "connection.update",
          bindingId: config.bindingId,
          args: { connected: false },
        }),
        expect.objectContaining({
          method: "connection.update",
          bindingId: config.bindingId,
          args: { connected: true },
        }),
      ]),
    );
    expect(globalFrames.map((frame) => frame.method)).toEqual([
      "session.bind",
      "task.create",
      "session.bind",
    ]);
  });
});
