import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BridgeAgentRequest,
  BridgeAgentResult,
  BridgeConfiguration,
  BridgeHello,
} from "../src/bridge-wire.js";
import { type PiExit, PiRpcProcess } from "../src/rpc-process.js";
import { ManagedSession } from "../src/session-runtime.js";

const hello: BridgeHello = {
  type: "agent.hello",
  version: 1,
  runtimeId: "runtime-a",
  nativeSessionId: "native-a",
  sessionFile: null,
  pid: 123,
  mode: "rpc",
  capabilities: {
    agentTools: true,
    messageDelivery: true,
    editorDraftGuard: true,
    toolPolicy: true,
  },
  context: { humanInputId: "human-a", causalMessageId: null },
};
const configuration: BridgeConfiguration = {
  version: 1,
  sessionId: "ses_agent",
  runtimeId: hello.runtimeId,
  nativeSessionId: hello.nativeSessionId,
  bindingId: "binding-a",
  features: ["agentRequests.v1", "policies.v1"],
  coordinatorConnected: true,
  policyRequired: true,
  sessionUrl: "https://switchyard.example/sessions/ses_agent",
};
const configured = {
  configured: true,
  agentTools: true,
  messageDelivery: true,
  policyRequired: true,
  policyState: "active",
  policyPhases: ["tool_call", "request"],
};
const request: BridgeAgentRequest = {
  type: "agent.request",
  requestId: "request-a",
  sessionId: configuration.sessionId,
  runtimeId: hello.runtimeId,
  nativeSessionId: hello.nativeSessionId,
  bindingId: configuration.bindingId,
  context: hello.context,
  method: "inbox.read",
  args: {},
};

/** Only the process boundary is mocked; exercise ManagedSession through its public API/events. */
class ProcessStub extends EventEmitter {
  exited: PiExit | null = null;
  request = vi.fn(async (cmd: { type: string }) =>
    cmd.type === "get_state"
      ? {
          sessionId: hello.nativeSessionId,
          sessionFile: "/tmp/native-a.jsonl",
          isStreaming: false,
        }
      : { disposition: "started" },
  );
  bridgeRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => configured);
  replyAgent = vi.fn();
}

async function startSession(announce = true) {
  const proc = new ProcessStub();
  vi.spyOn(PiRpcProcess, "start").mockResolvedValue(proc as unknown as PiRpcProcess);
  const session = new ManagedSession({
    sessionId: configuration.sessionId,
    newNativeSessionId: hello.nativeSessionId,
    cwd: "/tmp",
    title: "Agent contract",
    profile: {
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
      extraArgs: [],
    },
  });
  await session.start();
  if (announce) proc.emit("bridge_features", hello);
  return { session, proc };
}

afterEach(() => vi.restoreAllMocks());

describe("ManagedSession agent bridge contract", () => {
  it("emits the actual nested-capability hello without projecting protection into it", async () => {
    const { session, proc } = await startSession(false);
    expect(session.snapshot().bridge).toBeNull();
    const features = vi.fn();
    session.on("bridge_features", features);
    proc.emit("bridge_features", hello);
    expect(features).toHaveBeenCalledExactlyOnceWith(hello);
    expect(session.bridgeFeatures).toEqual(hello);
    expect(session.snapshot().bridge).toEqual({
      version: 1,
      runtimeId: hello.runtimeId,
      nativeSessionId: hello.nativeSessionId,
      agentTools: false,
      messageDelivery: false,
      policyState: "initializing",
      policyPhases: [],
    });
    features.mock.calls[0][0].capabilities.toolPolicy = false;
    const copy = session.bridgeFeatures!;
    copy.context.humanInputId = "changed";
    expect(session.bridgeFeatures).toEqual(hello);
  });

  it("waits for the configure receipt and preserves its enabled state separately from hello", async () => {
    const { session, proc } = await startSession();
    const deferred = Promise.withResolvers<unknown>();
    proc.bridgeRequest.mockReturnValueOnce(deferred.promise);
    const options = { timeoutMs: 30000, signal: new AbortController().signal };
    const pending = session.configureAgent(configuration, options);
    expect(proc.bridgeRequest).toHaveBeenCalledExactlyOnceWith("configure", configuration, options);
    expect(session.bridgeState?.policyState).toBe("initializing");
    deferred.resolve(configured);
    await expect(pending).resolves.toBe(configured);
    expect(session.bridgeState).toMatchObject({
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    });
    expect(session.bridgeFeatures).toEqual(hello);
    const snapshot = session.snapshot();
    snapshot.bridge!.policyPhases.length = 0;
    expect(session.bridgeState?.policyPhases).toEqual(["tool_call", "request"]);

    const disabled = {
      ...configured,
      agentTools: false,
      messageDelivery: false,
      policyState: "unsupported",
      policyPhases: [],
    };
    proc.bridgeRequest.mockResolvedValueOnce(disabled);
    await expect(
      session.configureAgent({ ...configuration, bindingId: "binding-disabled", features: [] }),
    ).resolves.toBe(disabled);
    expect(session.bridgeState).toMatchObject({
      agentTools: false,
      messageDelivery: false,
      policyState: "unsupported",
      policyPhases: [],
    });
    expect(session.bridgeFeatures?.capabilities.toolPolicy).toBe(true);
  });

  it("rejects substituted configure identities instead of silently overwriting them", async () => {
    const { session, proc } = await startSession();
    for (const key of ["sessionId", "runtimeId", "nativeSessionId"] as const) {
      await expect(
        session.configureAgent({ ...configuration, [key]: "substituted" }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    expect(proc.bridgeRequest).not.toHaveBeenCalled();
  });

  it("does not interpret configured:true or a failed command as active protection", async () => {
    const { session, proc } = await startSession();
    proc.bridgeRequest.mockResolvedValueOnce({ configured: true });
    await expect(session.configureAgent(configuration)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(session.bridgeState?.policyState).toBe("initializing");
    await session.configureAgent(configuration);
    proc.bridgeRequest.mockRejectedValueOnce(new Error("socket closed"));
    await expect(session.configureAgent(configuration)).rejects.toThrow("socket closed");
    expect(session.bridgeState?.policyState).toBe("initializing");
  });

  it.each(["same hello", "new runtime", "new native", "lost", "exit"])(
    "fences an in-flight configure after %s",
    async (change) => {
      const { session, proc } = await startSession();
      const deferred = Promise.withResolvers<unknown>();
      proc.bridgeRequest.mockReturnValueOnce(deferred.promise);
      const pending = session.configureAgent(configuration);
      const assertion = expect(pending).rejects.toMatchObject({ code: "conflict" });
      if (change === "lost") proc.emit("bridge_lost");
      else if (change === "exit") proc.emit("exit", { code: 0, signal: null, requested: true });
      else
        proc.emit("bridge_features", {
          ...hello,
          ...(change === "new runtime" ? { runtimeId: "runtime-b" } : {}),
          ...(change === "new native" ? { nativeSessionId: "native-b" } : {}),
        });
      deferred.resolve(configured);
      await assertion;
      expect(session.bridgeState?.policyState).not.toBe("active");
    },
  );

  it("forwards the direct request/result lane with bindingId while a prompt is pending", async () => {
    const { session, proc } = await startSession();
    const deferred = Promise.withResolvers<any>();
    proc.request.mockReturnValueOnce(deferred.promise);
    const prompt = session.prompt("hello");
    const seen = vi.fn();
    session.on("agent_request", seen);
    proc.emit("agent_request", request);
    expect(seen).toHaveBeenCalledExactlyOnceWith(request);
    const reply: BridgeAgentResult = {
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result: { messages: [] },
    };
    session.replyAgent(reply);
    expect(proc.replyAgent).toHaveBeenCalledExactlyOnceWith(reply);
    session.replyAgent({ ...reply, runtimeId: "obsolete" });
    expect(proc.replyAgent).toHaveBeenCalledTimes(1);
    for (const key of ["sessionId", "runtimeId", "nativeSessionId"] as const)
      proc.emit("agent_request", { ...request, [key]: "substituted" });
    expect(seen).toHaveBeenCalledTimes(1);
    deferred.resolve({ disposition: "started" });
    await prompt;
  });

  it("preserves busy state across multiple policy waits and clears waits on reannouncement/loss", async () => {
    const { session, proc } = await startSession();
    await session.configureAgent(configuration);
    proc.emit("event", { type: "agent_start" });
    session.setPolicyWaiting("decision-a", true);
    session.setPolicyWaiting("decision-b", true);
    expect(session.runtime).toBe("waiting_input");
    session.setPolicyWaiting("decision-a", false);
    expect(session.runtime).toBe("waiting_input");
    session.setPolicyWaiting("decision-b", false);
    expect(session.runtime).toBe("running");
    session.setPolicyWaiting("decision-a", true);
    proc.emit("bridge_features", hello);
    expect(session.snapshot().policyWaiting).toEqual([]);
    expect(session.bridgeState?.policyState).toBe("initializing");
    expect(session.runtime).toBe("running");
    session.setPolicyWaiting("decision-a", true);
    const lost = vi.fn();
    session.on("bridge_lost", lost);
    proc.emit("event", {
      type: "switchyard_native",
      sessionId: "native-b",
      sessionFile: "/tmp/native-b.jsonl",
    });
    expect(session.bridgeFeatures).toBeNull();
    expect(session.bridgeState?.policyState).toBe("lost");
    expect(session.snapshot().policyWaiting).toEqual([]);
    expect(lost).toHaveBeenCalledTimes(1);
    const seen = vi.fn();
    session.on("agent_request", seen);
    proc.emit("agent_request", request);
    expect(seen).not.toHaveBeenCalled();
  });

  it("passes bridge command options through and rejects disconnected/exited sessions", async () => {
    const { session, proc } = await startSession();
    const args = { humanInputId: "human-b" };
    const options = { timeoutMs: 1234, signal: new AbortController().signal };
    const receipt = { humanInputId: "human-b" };
    proc.bridgeRequest.mockResolvedValueOnce(receipt);
    await expect(session.bridgeRequest("input.human", args, options)).resolves.toBe(receipt);
    expect(proc.bridgeRequest).toHaveBeenCalledExactlyOnceWith("input.human", args, options);
    proc.exited = { code: 0, signal: null, requested: true };
    await expect(session.bridgeRequest("input.human", args)).rejects.toMatchObject({
      code: "host_unreachable",
    });
  });
});
