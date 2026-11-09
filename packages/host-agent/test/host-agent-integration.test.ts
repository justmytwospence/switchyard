import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfiguration, BridgeFeatures } from "@switchyard/pi-runtime";
import type { Profile } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import { AgentBroker } from "../src/agent-broker.js";
import { CommandRouter, queueKey, READ_ONLY_COMMANDS } from "../src/commands.js";
import { openHostDb } from "../src/db/index.js";
import { Dispatcher } from "../src/dispatch.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { MessageDeliveryWorker } from "../src/message-delivery.js";
import { SessionSupervisor, type StartParams, supportsAgentBridge } from "../src/supervisor.js";

const runtime = vi.hoisted(() => ({
  sessions: [] as any[],
  announce: true,
  configureGate: null as Promise<void> | null,
  inputGate: null as Promise<void> | null,
  adapterGate: null as Promise<void> | null,
  promptGate: null as Promise<void> | null,
  supported: true,
}));

vi.mock("@switchyard/pi-runtime", async (original) => {
  const actual = await original<typeof import("@switchyard/pi-runtime")>();
  const { EventEmitter } = await import("node:events");
  class ManagedSession extends EventEmitter {
    runtime = "starting";
    isAlive = true;
    transport: "rpc" | "terminal";
    process = {};
    terminalSocket = null;
    nextOrder = 0;
    bridgeFeatures: BridgeFeatures | null = null;
    configuration: BridgeConfiguration | null = null;
    calls: { method: string; args: any }[] = [];
    replies: unknown[] = [];
    waits: unknown[] = [];
    constructor(readonly options: any) {
      super();
      this.transport = options.transport;
      runtime.sessions.push(this);
    }
    announce(nativeSessionId = "native1") {
      this.bridgeFeatures = {
        type: "agent.hello",
        version: 1,
        runtimeId: "runtime1",
        nativeSessionId,
        sessionFile: "/native.jsonl",
        pid: 123,
        mode: this.transport,
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: runtime.supported,
        },
        context: { humanInputId: null, causalMessageId: null },
      };
      this.emit("bridge_features", this.bridgeFeatures);
    }
    async start() {
      if (runtime.announce) this.announce();
      this.emit("native", { sessionId: "native1", sessionFile: "/native.jsonl" });
      this.runtime = "idle";
      this.emit("runtime", { runtime: "idle", detail: null });
    }
    async configureAgent(configuration: BridgeConfiguration) {
      this.calls.push({ method: "configure", args: configuration });
      await runtime.configureGate;
      this.configuration = configuration;
      const agent = configuration.features.includes("agentRequests.v1");
      const active = agent && configuration.features.includes("policies.v1") && runtime.supported;
      return {
        configured: true,
        agentTools: agent,
        messageDelivery: agent,
        policyRequired: configuration.policyRequired,
        policyState: active ? "active" : "unsupported",
        policyPhases: active ? ["tool_call", "request"] : [],
      };
    }
    async bridgeRequest(method: string, args: unknown) {
      this.calls.push({ method, args });
      if (method === "input.human") await runtime.inputGate;
      return {};
    }
    replyAgent(frame: unknown) {
      this.replies.push(frame);
    }
    setPolicyWaiting(id: string, waiting: boolean) {
      this.waits.push({ id, waiting });
    }
    async prompt(text: string) {
      this.calls.push({ method: "prompt", args: text });
      await runtime.promptGate;
      return { disposition: "started", view: "visible" };
    }
    async stop() {
      this.isAlive = false;
      this.runtime = "stopped";
      this.emit("runtime", { runtime: "stopped", detail: null });
      this.emit("exit");
    }
    detach() {
      this.isAlive = false;
    }
  }
  return { ...actual, ManagedSession };
});

const profile: Profile = {
  id: "prf_mock",
  name: "Mock",
  provider: "mock",
  model: "mock-1",
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  runtime.sessions = [];
  runtime.announce = true;
  runtime.supported = true;
  runtime.configureGate = runtime.inputGate = runtime.adapterGate = runtime.promptGate = null;
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function waitForBinding(supervisor: SessionSupervisor, nativeSessionId = "native1") {
  await vi.waitFor(() => {
    expect(supervisor.deliveryBridge("ses_1")?.nativeSessionId).toBe(nativeSessionId);
    expect(supervisor.record("ses_1")?.bridge?.policyState).toBe("active");
  });
}

async function waitForConfigure() {
  await vi.waitFor(() => {
    expect(runtime.sessions[0]?.calls.map((c: any) => c.method)).toContain("configure");
  });
}

function fixture(
  options: {
    features?: string[];
    version?: string;
    brokerTimeoutMs?: number;
    terminal?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-host-lanes-"));
  const db = openHostDb(join(dir, "host.db"));
  const features = options.features ?? ["agentRequests.v1", "policies.v1"];
  const events = new EventEmitter();
  const requestAgent = vi.fn(async (sessionId, nativeSessionId, runtimeId, method, args) => {
    if (method !== "session.bind") return { verdict: "ALLOW" };
    return {
      version: 1,
      sessionId,
      nativeSessionId,
      runtimeId,
      features: features.filter((f) => f !== "policies.v1" || runtime.supported),
      policyRequired: args.policyRequired,
      sessionUrl: "https://switchyard.example/code/session",
    };
  });
  const link = {
    connected: true,
    negotiatedFeatures: new Set(features),
    events,
    requestAgent,
    emit: vi.fn(),
    sendStream: vi.fn(),
  } as unknown as CoordinatorLink;
  const broker = new AgentBroker({ link, timeoutMs: options.brokerTimeoutMs ?? 1000 });
  const wake = vi.fn();
  const catalog = {
    forWorkspace: async () => {
      await runtime.adapterGate;
      return { manifests: [], openSession: () => null, closeSession() {} };
    },
    manifests: () => [],
  } as unknown as AdapterCatalog;
  const supervisor = new SessionSupervisor({
    db,
    link,
    broker,
    hostId: "hst_1",
    catalog,
    log: silentLogger(),
    pi: () => ({ compatible: true, reason: null, version: options.version ?? "1.5.0" }),
    terminalSessions: options.terminal,
    onDeliveryWake: wake,
  });
  const params: StartParams = {
    sessionId: "ses_1",
    title: "Named",
    workspacePath: dir,
    projectId: null,
    profile,
    nativeHandle: null,
    initialPrompt: null,
    dispatchKey: null,
    controlRevision: 1,
    controlMode: "automation",
    origin: "automation",
  };
  cleanups.push(() => {
    broker.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const worker = new MessageDeliveryWorker({
    db,
    getBridge: (id) => supervisor.deliveryBridge(id),
  });
  cleanups.push(() => worker.stop());
  const dispatcher = new Dispatcher({
    db,
    supervisor,
    workspaces: {} as any,
    log: silentLogger(),
  });
  const router = new CommandRouter({
    db,
    supervisor,
    delivery: worker,
    dispatcher,
    workspaces: {} as any,
    log: silentLogger(),
    sendReceipt: () => {},
  });
  return { db, link, broker, supervisor, params, requestAgent, wake, worker, router, dispatcher };
}

function frame(ms: any, method = "inbox.read", args: unknown = {}) {
  return {
    type: "agent.request",
    requestId: randomUUID(),
    sessionId: "ses_1",
    runtimeId: ms.configuration.runtimeId,
    nativeSessionId: ms.configuration.nativeSessionId,
    bindingId: ms.configuration.bindingId,
    context: { humanInputId: "human1", causalMessageId: "message1" },
    method,
    args,
  };
}

describe("supervisor A.1 integration", () => {
  it.each(["1.4.9", "1.6.0", "1.5.0-beta.1", null, undefined])(
    "does not advertise new support for %s",
    (version) => {
      expect(supportsAgentBridge(version)).toBe(false);
    },
  );
  it.each(["1.5.0", "1.5.12"])("advertises potential support for %s", (version) => {
    expect(supportsAgentBridge(version)).toBe(true);
  });
  it("binds/configures before protected initial prompt and persists the actual receipt", async () => {
    const f = fixture();
    const gate = deferred();
    runtime.configureGate = gate.promise;
    const started = f.supervisor.start({
      ...f.params,
      policyRequired: true,
      initialPrompt: "work",
    });
    await waitForConfigure();
    const ms = runtime.sessions[0];
    expect(ms.options.env.SWITCHYARD_POLICY_REQUIRED).toBe("1");
    expect(ms.calls.map((c: any) => c.method)).toEqual(["configure"]);
    expect(f.supervisor.record("ses_1")?.bridge?.policyState).toBe("initializing");
    gate.resolve();
    expect((await started).promptError).toBeNull();
    expect(ms.calls.map((c: any) => c.method)).toEqual(["configure", "prompt"]);
    expect(f.supervisor.toSession(f.supervisor.record("ses_1")!).bridge?.policyState).toBe(
      "active",
    );
    expect(
      f.db.getJson<any>("SELECT json FROM sessions WHERE id = ?", ["ses_1"]).bridge.policyState,
    ).toBe("active");
  });
  it.each([{ version: "1.4.9" }, { features: [] }])(
    "refuses protected launches before spawning on unsupported host/coordinator",
    async (options) => {
      const f = fixture(options);
      await expect(
        f.supervisor.start({ ...f.params, policyRequired: true, initialPrompt: "never" }),
      ).rejects.toMatchObject({ code: "unsupported_capability" });
      expect(runtime.sessions).toHaveLength(0);
    },
  );
  it("does not send protected prompts for an unsupported actual hello", async () => {
    runtime.supported = false;
    const f = fixture();
    await expect(
      f.supervisor.start({ ...f.params, policyRequired: true, initialPrompt: "never" }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(runtime.sessions[0].isAlive).toBe(false);
    expect(runtime.sessions[0].calls.some((c: any) => c.method === "prompt")).toBe(false);
  });
  it("lets stop interrupt protected startup with no hello without silently restarting it", async () => {
    runtime.announce = false;
    const f = fixture({ brokerTimeoutMs: 10 });
    // ready has the normative 30s startup cap, so use an abort like a stop command does.
    const started = f.supervisor.start({
      ...f.params,
      policyRequired: true,
      initialPrompt: "never",
    });
    await flush();
    await f.supervisor.stop("ses_1");
    await started;
    expect(runtime.sessions).toHaveLength(1);
    expect(runtime.sessions[0].calls.some((c: any) => c.method === "prompt")).toBe(false);
  });
  it("enforces the 30-second startup deadline when no bridge hello arrives", async () => {
    vi.useFakeTimers();
    try {
      runtime.announce = false;
      const f = fixture();
      const started = f.supervisor
        .start({ ...f.params, policyRequired: true, initialPrompt: "never" })
        .catch((error: unknown) => error);
      await flush();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await started).toMatchObject({ code: "timeout" });
      expect(runtime.sessions[0].isAlive).toBe(false);
      expect(runtime.sessions[0].calls.some((c: any) => c.method === "prompt")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("records a fresh human id before a native prompt, never for automation", async () => {
    const f = fixture();
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const ms = runtime.sessions[0];
    const gate = deferred();
    runtime.inputGate = gate.promise;
    const human = f.supervisor.prompt("ses_1", "human", [], "prompt", "human");
    await flush();
    expect(ms.calls.at(-1).method).toBe("input.human");
    expect(ms.calls.at(-1).args.humanInputId).toMatch(/^[0-9a-f-]{36}$/);
    gate.resolve();
    await human;
    await f.supervisor.prompt("ses_1", "automated", [], "prompt", "automation");
    expect(ms.calls.map((c: any) => c.method)).toEqual([
      "configure",
      "input.human",
      "prompt",
      "prompt",
    ]);
  });
  it("forwards agent requests outside both blocked prompt and adapter chains", async () => {
    const gate = deferred();
    runtime.adapterGate = gate.promise;
    runtime.promptGate = gate.promise;
    const f = fixture();
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const prompt = f.router.handle("prompt", {
      type: "session.prompt",
      sessionId: "ses_1",
      text: "/wait",
      images: [],
      mode: "prompt",
      origin: "automation",
      controlRevision: 2,
    });
    await flush();
    const ms = runtime.sessions[0];
    const request = frame(ms);
    ms.emit("agent_request", request);
    await flush();
    expect(ms.replies).toEqual([
      expect.objectContaining({
        requestId: request.requestId,
        bindingId: request.bindingId,
        ok: true,
      }),
    ]);
    expect(f.requestAgent.mock.calls.at(-1)?.[5]?.context).toEqual(request.context);
    gate.resolve();
    await prompt;
  });
  it("routes policy ASK waiting state directly and clears it on disconnect", async () => {
    const f = fixture();
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const ms = runtime.sessions[0];
    f.requestAgent.mockImplementationOnce(async () => ({
      verdict: "ASK",
      decisionId: "decision1",
    }));
    ms.emit("agent_request", {
      ...frame(ms, "policy.evaluate", {
        evaluationId: "evaluation1",
        toolCallId: "call1",
        tool: { name: "read", args: { path: f.params.workspacePath } },
      }),
      toolCallId: "call1",
    });
    await vi.waitFor(() => {
      expect(ms.waits).toEqual([{ id: "decision1", waiting: true }]);
    });
    f.link.connected = false;
    f.link.events.emit("disconnected", { code: 1006, reason: "lost" });
    expect(ms.waits.at(-1)).toEqual({ id: "decision1", waiting: false });
    expect(f.supervisor.record("ses_1")?.bridge?.policyState).toBe("lost");
    expect(ms.calls.at(-1)).toEqual({ method: "connection.update", args: { connected: false } });
  });
  it("fences old delivery adapters across native rebinds and permits offline status only", async () => {
    const f = fixture();
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const ms = runtime.sessions[0];
    const old = f.supervisor.deliveryBridge("ses_1")!;
    expect(old).not.toBeNull();
    f.link.connected = false;
    f.link.events.emit("disconnected", { code: 1006, reason: "offline" });
    const signal = new AbortController().signal;
    await old.status({} as any, { signal });
    expect(() => old.accept({} as any, { signal })).toThrow(/obsolete/);
    f.link.connected = true;
    f.link.events.emit("welcome", { coordinatorVersion: "test", ackedHostSeq: 0 });
    await waitForBinding(f.supervisor);
    ms.announce("native2");
    await waitForBinding(f.supervisor, "native2");
    const current = f.supervisor.deliveryBridge("ses_1")!;
    expect(current.nativeSessionId).toBe("native2");
    expect(current.bindingId).not.toBe(old.bindingId);
    expect(() => old.status({} as any, { signal })).toThrow(/obsolete/);
    ms.emit("bridge_lost");
    expect(f.supervisor.deliveryBridge("ses_1")).toBeNull();
    expect(f.supervisor.record("ses_1")?.bridge?.policyState).toBe("lost");
  });
  it("wires terminal reattachment through the same broker without replacing Pi", async () => {
    const f = fixture({ terminal: true });
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    runtime.sessions[0].emit("terminal", { socketPath: "/holder.sock" });
    await f.supervisor.stopAll();
    const next = new SessionSupervisor({
      db: f.db,
      link: f.link,
      broker: f.broker,
      hostId: "hst_1",
      catalog: {
        forWorkspace: async () => {
          throw new Error("no adapters");
        },
      } as any,
      log: silentLogger(),
      pi: () => ({ compatible: true, reason: null, version: "1.5.0" }),
    });
    next.recoverAfterRestart();
    expect((await next.reattachTerminals()).reattached).toEqual(["ses_1"]);
    await waitForBinding(next);
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.sessions[1].options.terminalSocket).toBe("/holder.sock");
    expect(runtime.sessions[1].configuration.nativeSessionId).toBe("native1");
    expect(next.record("ses_1")?.bridge?.policyState).toBe("active");
    await next.stopAll();
  });
  it("closes the broker on exit even when the adapter chain is blocked", async () => {
    const f = fixture();
    const gate = deferred();
    runtime.adapterGate = gate.promise;
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const ms = runtime.sessions[0];
    const request = frame(ms);
    ms.emit("exit");
    ms.emit("agent_request", request);
    await flush();
    expect(ms.replies).toHaveLength(0);
    expect(f.supervisor.deliveryBridge("ses_1")).toBeNull();
    gate.resolve();
    await flush();
  });
});

describe("durable message command integration", () => {
  const delivery = {
    type: "session.deliverMessage",
    sessionId: "ses_1",
    messageId: "message1",
    payload: { deliveryId: "message1", kind: "message", text: "Inbox message" },
    mode: "steer",
    holdUntil: "2030-01-01T00:10:00.000Z",
  };
  it("uses a separate acceptance lane and fresh read-only status", () => {
    expect(queueKey(delivery as any)).toBe("message:ses_1");
    expect(
      queueKey({ type: "session.messageStatus", sessionId: "ses_1", messageIds: ["message1"] }),
    ).toBeNull();
    expect(READ_ONLY_COMMANDS.has("session.messageStatus")).toBe(true);
  });
  it("persists acceptance without resuming a recipient; logical dedupe survives generic receipt pruning", async () => {
    const f = fixture();
    f.db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [
      "ses_1",
      JSON.stringify({ id: "ses_1", runtime: "stopped" }),
    ]);
    const receipt = await f.router.handle("msg_message1", delivery);
    expect(receipt.ok).toBe(true);
    await flush();
    expect(runtime.sessions).toHaveLength(0);
    expect(f.db.get<any>("SELECT count(*) AS n FROM message_receipts").n).toBe(1);
    f.db.run("DELETE FROM receipts");
    expect((await f.router.handle("new_transport_id", delivery)).ok).toBe(true);
    expect(f.db.get<any>("SELECT count(*) AS n FROM message_receipts").n).toBe(1);
    expect(f.worker.getStatus("ses_1", ["message1"]).messages[0]).toMatchObject({
      state: "accepted",
      attemptId: null,
    });
    await f.worker.tick();
    expect(runtime.sessions).toHaveLength(0);
    const status = await f.router.handle("status1", {
      type: "session.messageStatus",
      sessionId: "ses_1",
      messageIds: ["message1"],
    });
    expect(status).toMatchObject({
      ok: true,
      result: { messages: [{ messageId: "message1", state: "deferred" }] },
    });
    expect(
      f.db.getJson<any>("SELECT json FROM receipts WHERE command_id = ?", ["status1"]).ok,
    ).toBe(true);
  });
  it("serves acceptance and changing statuses while a prompt is in flight", async () => {
    const f = fixture();
    await f.supervisor.start(f.params);
    await waitForBinding(f.supervisor);
    const gate = deferred();
    runtime.promptGate = gate.promise;
    const prompt = f.router.handle("prompt", {
      type: "session.prompt",
      sessionId: "ses_1",
      text: "/wait",
      mode: "prompt",
      images: [],
      origin: "automation",
      controlRevision: 2,
    });
    await flush();
    const ms = runtime.sessions[0];
    const bridgeRequest = vi
      .spyOn(ms, "bridgeRequest")
      .mockImplementation(
        async (method: string, args: { offer: { deliveryId: string }; attempt: unknown }) => {
          expect(method).toBe("delivery.accept");
          return {
            deliveryId: args.offer.deliveryId,
            attempt: args.attempt,
            state: "appended",
            proof: "native_entry",
            safeToRetry: false,
            entryId: "entry1",
            effectiveMode: "steer",
            reason: null,
          };
        },
      );
    try {
      expect(await f.router.handle("message", delivery)).toMatchObject({
        ok: true,
        result: { state: "accepted", attemptId: null },
      });
      expect(bridgeRequest).not.toHaveBeenCalled();
      await f.worker.tick();
      expect(bridgeRequest).toHaveBeenCalledTimes(1);
      const status = await f.router.handle("status2", {
        type: "session.messageStatus",
        sessionId: "ses_1",
        messageIds: ["message1"],
      });
      expect(status).toMatchObject({
        ok: true,
        result: { messages: [{ state: "appended", attemptId: expect.any(String) }] },
      });
    } finally {
      gate.resolve();
      await prompt;
    }
  });
  function dispatchCommand(workspacePath: string) {
    return {
      type: "dispatch.start" as const,
      dispatchKey: "dispatch1",
      runId: "run1",
      sessionId: "ses_1",
      workspace: { path: workspacePath },
      projectId: "prj_1",
      profile,
      nativeHandle: null,
      title: "Named",
      prompt: "work",
      controlRevision: 1,
      controlMode: "automation" as const,
      taskId: "task1",
      policyRequired: true,
    };
  }
  it("forwards protected dispatch through configure before prompting and deduplicates retries", async () => {
    const f = fixture();
    const gate = deferred();
    runtime.configureGate = gate.promise;
    const command = dispatchCommand(f.params.workspacePath);
    const pending = f.router.handle("dispatch", command);
    await waitForConfigure();
    const ms = runtime.sessions[0];
    expect(ms.options.env.SWITCHYARD_POLICY_REQUIRED).toBe("1");
    expect(ms.calls.map((c: any) => c.method)).toEqual(["configure"]);
    expect(ms.calls[0].args.policyRequired).toBe(true);
    expect(f.dispatcher.get(command.dispatchKey)?.state).toBe("workspace_ready");
    gate.resolve();
    expect(await pending).toMatchObject({ ok: true, result: { reused: false, promptError: null } });
    expect(ms.calls.map((c: any) => c.method)).toEqual(["configure", "prompt"]);
    expect(f.supervisor.record("ses_1")?.bridge?.policyState).toBe("active");
    expect(f.dispatcher.get(command.dispatchKey)?.state).toBe("started");
    expect(await f.router.handle("dispatch_retry", command)).toMatchObject({
      ok: true,
      result: { reused: true },
    });
    expect(runtime.sessions).toHaveLength(1);
    expect(ms.calls.filter((c: any) => c.method === "prompt")).toHaveLength(1);
  });
  it.each([{ version: "1.4.9" }, { features: [] }, { supported: false }])(
    "keeps protected dispatch fail-closed when enforcement is unavailable: %j",
    async (options) => {
      if ("supported" in options) runtime.supported = options.supported;
      const f = fixture(options);
      const command = dispatchCommand(f.params.workspacePath);
      expect(await f.router.handle("dispatch", command)).toMatchObject({
        ok: false,
        error: { code: "unsupported_capability" },
      });
      expect(f.dispatcher.get(command.dispatchKey)?.state).toBe("failed");
      expect(runtime.sessions.every((ms) => !ms.isAlive)).toBe(true);
      expect(runtime.sessions.flatMap((ms) => ms.calls).some((c) => c.method === "prompt")).toBe(
        false,
      );
      expect(await f.router.handle("dispatch_retry", command)).toMatchObject({
        ok: false,
        error: { code: "unsupported_capability", details: { reused: true } },
      });
    },
  );
});
