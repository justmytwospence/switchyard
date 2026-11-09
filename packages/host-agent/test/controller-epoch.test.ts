import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentRequestFrame } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentBroker,
  type AgentBrokerConfiguration,
  type AgentBrokerHello,
  type AgentBrokerOptions,
  type AgentBrokerSession,
  type AgentBrokerState,
} from "../src/agent-broker.js";
import type { CoordinatorLink } from "../src/link.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  let connected = true;
  let features = ["agentRequests.v1", "policies.v1"];
  const events: CoordinatorLink["events"] = new EventEmitter();
  const states: AgentBrokerState[] = [];
  const bindings: { epoch: string; state: AgentBrokerState | undefined }[] = [];
  const requestAgent = vi.fn<CoordinatorLink["requestAgent"]>(
    async (sessionId, nativeSessionId, runtimeId, method, args) => {
      if (method !== "session.bind") return { done: true };
      bindings.push({
        epoch: (args as { controllerEpoch: string }).controllerEpoch,
        state: states.at(-1),
      });
      return {
        version: 1,
        sessionId,
        nativeSessionId,
        runtimeId,
        features,
        policyRequired: false,
        sessionUrl: features.includes("policies.v1")
          ? "https://switchyard.test/code/session"
          : null,
      };
    },
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
  const hello: AgentBrokerHello = {
    type: "agent.hello",
    version: 1,
    runtimeId: "runtime",
    nativeSessionId: "native",
    sessionFile: null,
    pid: 123,
    mode: "rpc",
    capabilities: {
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: true,
    },
    context: { humanInputId: null, causalMessageId: null },
  };
  const session: AgentBrokerSession = {
    sessionId: "session",
    mode: "rpc",
    policyRequired: false,
    getPolicyBoundary: async () => ({
      cwd: "/repo",
      cwdReal: "/repo",
      workspaceRoot: "/repo",
      workspaceRootReal: "/repo",
    }),
    getToolPolicyContext: vi.fn(),
    configureAgent: vi.fn(async (config: AgentBrokerConfiguration) => {
      const active = config.features.includes("policies.v1");
      expect(states.at(-1)?.controllerEpoch).toBe(bindings.at(-1)?.epoch);
      expect(states.at(-1)?.policyState).toBe("initializing");
      expect(config).not.toHaveProperty("controllerEpoch");
      return {
        configured: true,
        agentTools: true,
        messageDelivery: true,
        policyRequired: false,
        policyState: active ? "active" : "unsupported",
        policyPhases: active ? ["tool_call", "request"] : [],
      };
    }),
    bridgeRequest: vi.fn(async () => undefined),
    replyAgent: vi.fn(),
    setPolicyWaiting: vi.fn(),
    onState: (state) => states.push(state),
  };
  const broker = new AgentBroker({ link });
  cleanup.push(() => broker.close());
  return {
    broker,
    handle: broker.attach(session),
    hello,
    session,
    states,
    bindings,
    requestAgent,
    disconnect() {
      connected = false;
      events.emit("disconnected", { code: 1006, reason: "test" });
    },
    welcome(next = features) {
      features = next;
      connected = true;
      events.emit("welcome", { coordinatorVersion: "test", ackedHostSeq: 0, features });
    },
  };
}

function epoch(state: AgentBrokerState | undefined): string {
  expect(state?.controllerEpoch).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  return state!.controllerEpoch!;
}

describe("host-generated controller epochs", () => {
  it("publishes a fresh epoch before configure and replaces it for same-native/runtime reattachment", async () => {
    const f = fixture();
    await f.handle.hello({
      ...f.hello,
      controllerEpoch: "pi-forgery",
      bindingId: "private-forgery",
    });
    const first = epoch(f.states.at(-1));
    const bindingId = f.handle.snapshot().configuration!.bindingId;
    expect(first).not.toBe(bindingId);
    expect(f.bindings[0]).toMatchObject({ epoch: first, state: { controllerEpoch: first } });
    await f.handle.hello(f.hello);
    const second = epoch(f.states.at(-1));
    expect(second).not.toBe(first);
    expect(f.bindings.at(-1)?.epoch).toBe(second);
    expect(f.handle.snapshot().configuration!.bindingId).not.toBe(bindingId);
    f.handle.lost();
    expect(f.states.at(-1)).toMatchObject({
      controllerEpoch: second,
      policyState: "lost",
      agentTools: false,
      messageDelivery: false,
      policyPhases: [],
    });
    await f.handle.hello(f.hello);
    const third = epoch(f.states.at(-1));
    expect(third).not.toBe(second);
    const replacement = f.broker.attach(f.session);
    await replacement.hello(f.hello);
    expect(epoch(f.states.at(-1))).not.toBe(third);
  });

  it("preserves the epoch and private binding across a pure coordinator reconnect", async () => {
    const f = fixture();
    await f.handle.hello(f.hello);
    const first = epoch(f.states.at(-1));
    const bindingId = f.handle.snapshot().configuration!.bindingId;
    f.disconnect();
    expect(f.states.at(-1)).toMatchObject({
      controllerEpoch: first,
      policyState: "lost",
      policyPhases: [],
    });
    f.welcome();
    await f.handle.ready({ require: "policies" });
    expect(epoch(f.states.at(-1))).toBe(first);
    expect(f.bindings.map((binding) => binding.epoch)).toEqual([first, first]);
    expect(f.handle.snapshot().configuration!.bindingId).toBe(bindingId);
    expect(f.session.configureAgent).toHaveBeenCalledTimes(1);
    expect(f.session.bridgeRequest).toHaveBeenCalledWith("connection.update", { connected: false });
    expect(f.session.bridgeRequest).toHaveBeenCalledWith(
      "connection.update",
      { connected: true },
      expect.any(Object),
    );
  });

  it("rebinds a new epoch centrally if reconnect requires a new local configuration", async () => {
    const f = fixture();
    await f.handle.hello(f.hello);
    const first = epoch(f.states.at(-1));
    f.disconnect();
    f.welcome(["agentRequests.v1"]);
    await f.handle.ready({ require: "agentRequests" });
    const next = epoch(f.states.at(-1));
    expect(next).not.toBe(first);
    expect(f.bindings.map((binding) => binding.epoch)).toEqual([first, first, next]);
    expect(f.bindings.at(-1)?.state).toMatchObject({
      controllerEpoch: next,
      policyState: "initializing",
    });
    expect(f.session.configureAgent).toHaveBeenCalledTimes(2);
    expect(f.states.at(-1)?.policyState).toBe("unsupported");
  });

  it("replaces an uncertain configure epoch before retrying configuration", async () => {
    const f = fixture();
    vi.mocked(f.session.configureAgent).mockRejectedValueOnce(new Error("lost receipt"));
    await expect(f.handle.hello(f.hello)).rejects.toThrow("lost receipt");
    const first = epoch(f.states.at(-1));
    f.welcome();
    await f.handle.ready();
    expect(epoch(f.states.at(-1))).not.toBe(first);
    expect(f.bindings.at(-1)?.epoch).toBe(f.states.at(-1)?.controllerEpoch);
  });

  it("rejects Pi-supplied epoch metadata and broker-only binding requests without forwarding", async () => {
    const f = fixture();
    await f.handle.hello(f.hello);
    const configuration = f.handle.snapshot().configuration!;
    const frame: AgentRequestFrame & { bindingId: string } = {
      type: "agent.request",
      requestId: randomUUID(),
      sessionId: "session",
      runtimeId: "runtime",
      nativeSessionId: "native",
      bindingId: configuration.bindingId,
      context: { humanInputId: null, causalMessageId: null },
      method: "session.bind",
      args: { controllerEpoch: randomUUID() },
    };
    const before = f.requestAgent.mock.calls.length;
    await f.handle.request(frame);
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "forbidden" }) }),
    );
    await f.handle.request({ ...frame, method: "inbox.read", controllerEpoch: randomUUID() });
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_request" }),
      }),
    );
    expect(f.requestAgent).toHaveBeenCalledTimes(before);
    expect(f.states.at(-1)?.controllerEpoch).toBe(f.bindings[0]?.epoch);
  });
});
