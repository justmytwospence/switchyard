import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  AGENT_FRAME_MAX_BYTES,
  AgentRequestFrame,
  canonicalPolicyJson,
  HostAgentRequestFrame,
  type HostPolicyBoundary,
  type HostToolPolicyContext,
  type PolicyEvaluateRequest,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const BOUNDARY: HostPolicyBoundary = {
  cwd: "/workspace/project",
  workspaceRoot: "/workspace",
  cwdReal: "/real/workspace/project",
  workspaceRootReal: "/real/workspace",
};
function evaluation(): PolicyEvaluateRequest {
  return {
    evaluationId: "evaluation1",
    toolCallId: "tool1",
    tool: { name: "read", args: { path: "README.md" } },
  };
}
function attestation(request = evaluation()): HostToolPolicyContext {
  return {
    version: 1,
    toolCallId: request.toolCallId,
    toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
    boundary: { ...BOUNDARY },
    defaultBranch: null,
    safety: {
      destructiveDelete: false,
      forcePush: false,
      defaultBranchPush: false,
      uncertain: false,
      reasons: [],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

function brokerFixture(features = FEATURES, toolPolicy = true) {
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
      toolPolicy,
    },
    context: { humanInputId: "human1", causalMessageId: null },
  };
  const events: CoordinatorLink["events"] = new EventEmitter();
  const requestAgent = vi.fn<CoordinatorLink["requestAgent"]>(
    async (sessionId, nativeSessionId, runtimeId, method, args) => {
      if (method !== "session.bind") return { verdict: "ALLOW" };
      const actualFeatures = features.filter((f) => f !== "policies.v1" || toolPolicy);
      return {
        version: 1,
        sessionId,
        nativeSessionId,
        runtimeId,
        features: actualFeatures,
        policyRequired: (args as { policyRequired: boolean }).policyRequired,
        sessionUrl: actualFeatures.includes("policies.v1")
          ? "https://switchyard.example/code/ses1"
          : null,
      };
    },
  );
  const link = {
    connected: true,
    negotiatedFeatures: new Set(features),
    events,
    requestAgent,
  } satisfies AgentBrokerOptions["link"];
  const session = {
    sessionId: "ses1",
    mode: "rpc" as const,
    policyRequired: false,
    getPolicyBoundary: vi.fn<AgentBrokerSession["getPolicyBoundary"]>(async () => ({
      ...BOUNDARY,
    })),
    getToolPolicyContext: vi.fn<AgentBrokerSession["getToolPolicyContext"]>(async (args) =>
      attestation(args),
    ),
    configureAgent: vi.fn<AgentBrokerSession["configureAgent"]>(async (config) => {
      const agent = config.features.includes("agentRequests.v1");
      const active = agent && toolPolicy && config.features.includes("policies.v1");
      return {
        configured: true,
        agentTools: agent,
        messageDelivery: agent,
        policyRequired: config.policyRequired,
        policyState: active ? "active" : "unsupported",
        policyPhases: active ? ["tool_call", "request"] : [],
      };
    }),
    bridgeRequest: vi.fn<AgentBrokerSession["bridgeRequest"]>(async () => ({})),
    replyAgent: vi.fn<AgentBrokerSession["replyAgent"]>(),
    setPolicyWaiting: vi.fn<AgentBrokerSession["setPolicyWaiting"]>(),
  };
  const broker = new AgentBroker({ link });
  cleanup.push(() => broker.close());
  const handle = broker.attach(session);
  function frame(overrides: Partial<AgentBrokerRequest> = {}): AgentBrokerRequest {
    const config = handle.snapshot().configuration!;
    return {
      type: "agent.request",
      requestId: randomUUID(),
      sessionId: session.sessionId,
      runtimeId: config.runtimeId,
      nativeSessionId: config.nativeSessionId,
      bindingId: config.bindingId,
      context: { humanInputId: "human2", causalMessageId: "message1" },
      method: "policy.evaluate",
      toolCallId: "tool1",
      args: evaluation(),
      ...overrides,
    };
  }
  return { session, hello, handle, link, frame };
}

describe("D.2 broker host-only policy attestation", () => {
  it("binds the adapter boundary even for optional enforcement, ignoring hello path claims", async () => {
    const f = brokerFixture();
    await f.handle.hello({ ...f.hello, cwd: "/forged", workspaceRoot: "/" });
    expect(f.session.getPolicyBoundary).toHaveBeenCalledOnce();
    const epoch = f.handle.snapshot().bridge?.controllerEpoch;
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.link.requestAgent).toHaveBeenCalledWith(
      "ses1",
      "native1",
      "runtime1",
      "session.bind",
      {
        version: 1,
        sessionFile: null,
        mode: "rpc",
        capabilities: f.hello.capabilities,
        policyRequired: false,
        controllerEpoch: epoch,
        policyBoundary: BOUNDARY,
      },
      expect.any(Object),
    );
    expect(f.handle.snapshot().bridge?.policyState).toBe("active");
  });

  it.each([
    { features: [], toolPolicy: true },
    { features: ["agentRequests.v1"], toolPolicy: true },
    { features: FEATURES, toolPolicy: false },
  ])("preserves legacy/direct lanes without a capable policy binding: %j", async (options) => {
    const f = brokerFixture(options.features, options.toolPolicy);
    f.session.getPolicyBoundary.mockRejectedValue(new Error("must not resolve legacy paths"));
    await f.handle.hello(f.hello);
    expect(f.session.getPolicyBoundary).not.toHaveBeenCalled();
    expect(f.handle.snapshot().bridge?.policyState).toBe("unsupported");
    for (const call of f.link.requestAgent.mock.calls)
      expect(call[4]).not.toHaveProperty("policyBoundary");
    if (!options.features.length) expect(f.link.requestAgent).not.toHaveBeenCalled();
  });

  it.each([new Error("ENOENT"), { ...BOUNDARY, cwdReal: "/outside" }])(
    "fails bind closed if boundary is unavailable or invalid: %j",
    async (failure) => {
      const f = brokerFixture();
      if (failure instanceof Error) f.session.getPolicyBoundary.mockRejectedValueOnce(failure);
      else f.session.getPolicyBoundary.mockResolvedValueOnce(failure);
      await expect(f.handle.hello(f.hello)).rejects.toMatchObject({
        code: "forbidden",
        message: "Cannot verify workspace boundary for policy enforcement.",
      });
      expect(f.link.requestAgent).not.toHaveBeenCalled();
      expect(f.session.configureAgent).not.toHaveBeenCalled();
      expect(f.handle.snapshot().bridge?.policyState).not.toBe("active");
    },
  );

  it("fences delayed boundary resolution before sending session.bind", async () => {
    const f = brokerFixture();
    const pending = deferred<HostPolicyBoundary>();
    f.session.getPolicyBoundary.mockReturnValueOnce(pending.promise);
    const old = f.handle.hello(f.hello).catch((error) => error);
    await vi.waitFor(() => expect(f.session.getPolicyBoundary).toHaveBeenCalledOnce());
    await f.handle.hello({ ...f.hello, nativeSessionId: "native2" });
    pending.resolve(BOUNDARY);
    await old;
    expect(f.link.requestAgent).toHaveBeenCalledOnce();
    expect(f.link.requestAgent.mock.calls[0]?.[1]).toBe("native2");
    expect(f.handle.snapshot().configuration?.nativeSessionId).toBe("native2");
  });

  it("forwards strict Pi args with independently collected context and restores the local binding", async () => {
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    const request = f.frame();
    await f.handle.request(request);
    expect(f.session.getToolPolicyContext).toHaveBeenCalledWith(
      evaluation(),
      expect.any(AbortSignal),
    );
    expect(f.link.requestAgent).toHaveBeenLastCalledWith(
      "ses1",
      "native1",
      "runtime1",
      "policy.evaluate",
      evaluation(),
      expect.objectContaining({
        toolCallId: "tool1",
        policyContext: attestation(),
        context: request.context,
      }),
    );
    expect(f.session.replyAgent).toHaveBeenLastCalledWith({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result: { verdict: "ALLOW" },
    });
  });

  it.each([
    (frame: AgentBrokerRequest) => ({ ...frame, policyContext: attestation() }),
    (frame: AgentBrokerRequest) => ({ ...frame, safety: attestation().safety }),
    (frame: AgentBrokerRequest) => ({ ...frame, cwd: "/forged" }),
    (frame: AgentBrokerRequest) => ({ ...frame, context: { ...frame.context, cwd: "/forged" } }),
    (frame: AgentBrokerRequest) => ({
      ...frame,
      args: { ...evaluation(), policyContext: attestation() },
    }),
    (frame: AgentBrokerRequest) => ({
      ...frame,
      args: { ...evaluation(), safety: attestation().safety },
    }),
    (frame: AgentBrokerRequest) => ({ ...frame, args: { ...evaluation(), cwd: "/forged" } }),
    (frame: AgentBrokerRequest) => ({
      ...frame,
      args: { ...evaluation(), tool: { ...evaluation().tool, safety: attestation().safety } },
    }),
    (frame: AgentBrokerRequest) => ({ ...frame, toolCallId: "substituted" }),
    (frame: AgentBrokerRequest) => ({ ...frame, toolCallId: undefined }),
  ])("rejects forged context/extra policy args or mismatched tool identity (%#)", async (forge) => {
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    await f.handle.request(forge(f.frame()));
    expect(f.session.getToolPolicyContext).not.toHaveBeenCalled();
    expect(f.link.requestAgent).toHaveBeenCalledOnce(); // bind only
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_request" }),
      }),
    );
  });

  it.each(["lost", "close", "reattach", "disconnect"] as const)(
    "does not forward delayed classifier results after %s",
    async (event) => {
      const f = brokerFixture();
      await f.handle.hello(f.hello);
      const pending = deferred<HostToolPolicyContext>();
      f.session.getToolPolicyContext.mockReturnValueOnce(pending.promise);
      const work = f.handle.request(f.frame());
      await vi.waitFor(() => expect(f.session.getToolPolicyContext).toHaveBeenCalledOnce());
      const signal = f.session.getToolPolicyContext.mock.calls[0]![1]!;
      if (event === "reattach") await f.handle.hello(f.hello);
      else if (event === "disconnect") {
        f.link.connected = false;
        f.handle.disconnect();
      } else f.handle[event]();
      pending.resolve(attestation());
      await work;
      expect(signal.aborted).toBe(true);
      expect(
        f.link.requestAgent.mock.calls.filter((call) => call[3] === "policy.evaluate"),
      ).toEqual([]);
      expect(f.session.replyAgent.mock.calls.some(([reply]) => reply.ok)).toBe(false);
      if (event === "disconnect")
        expect(f.session.replyAgent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: "host_unreachable" }),
          }),
        );
    },
  );

  it("keeps inbox and native human-input lanes independent of slow policy classification", async () => {
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    const pending = deferred<HostToolPolicyContext>();
    f.session.getToolPolicyContext.mockReturnValueOnce(pending.promise);
    const work = f.handle.request(f.frame());
    await f.handle.request(f.frame({ method: "inbox.read", args: { after: 0, limit: 20 } }));
    await f.handle.humanInput();
    expect(f.link.requestAgent).toHaveBeenLastCalledWith(
      "ses1",
      "native1",
      "runtime1",
      "inbox.read",
      { after: 0, limit: 20 },
      expect.not.objectContaining({ policyContext: expect.anything() }),
    );
    expect(f.session.bridgeRequest).toHaveBeenCalledWith(
      "input.human",
      expect.any(Object),
      expect.any(Object),
    );
    pending.resolve(attestation());
    await work;
  });

  it("denies classifier failures instead of forwarding all-false safety", async () => {
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    f.session.getToolPolicyContext.mockRejectedValueOnce(
      new SwitchyardError("forbidden", "Boundary changed"),
    );
    await f.handle.request(f.frame());
    expect(f.link.requestAgent).toHaveBeenCalledOnce();
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "forbidden" }) }),
    );
  });

  it("shares one fixed deadline across classification and coordinator communication", async () => {
    vi.useFakeTimers();
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    const context = deferred<HostToolPolicyContext>();
    const result = deferred<unknown>();
    f.session.getToolPolicyContext.mockReturnValueOnce(context.promise);
    f.link.requestAgent.mockReturnValueOnce(result.promise);
    const work = f.handle.request(f.frame());
    await vi.advanceTimersByTimeAsync(12_000);
    context.resolve(attestation());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.link.requestAgent.mock.lastCall?.[5]?.timeoutMs).toBe(18_000);
    await vi.advanceTimersByTimeAsync(17_999);
    expect(f.session.replyAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(f.session.replyAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "timeout" }),
      }),
    );
    result.resolve({ verdict: "ALLOW" });
  });

  it("bounds startup boundary resolution even if the adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    const f = brokerFixture();
    const boundary = deferred<HostPolicyBoundary>();
    f.session.getPolicyBoundary.mockReturnValueOnce(boundary.promise);
    const work = f.handle.hello(f.hello).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await work).toMatchObject({ code: "timeout" });
    boundary.resolve(BOUNDARY);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.link.requestAgent).not.toHaveBeenCalled();
    expect(f.session.configureAgent).not.toHaveBeenCalled();
  });

  it("bounds classifier waits even when the adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    const f = brokerFixture();
    await f.handle.hello(f.hello);
    const pending = deferred<HostToolPolicyContext>();
    f.session.getToolPolicyContext.mockReturnValueOnce(pending.promise);
    const work = f.handle.request(f.frame());
    await vi.advanceTimersByTimeAsync(30_000);
    await work;
    expect(f.link.requestAgent).toHaveBeenCalledOnce();
    expect(f.session.replyAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "timeout" }) }),
    );
    pending.resolve(attestation());
  });
});

describe("D.2 enriched host request wire", () => {
  let db: HostDb;
  let server: WebSocketServer;
  let socket: WebSocket;
  let link: CoordinatorLink;
  let frames: Array<Record<string, unknown>>;

  beforeEach(async () => {
    frames = [];
    db = new HostDb(":memory:");
    db.migrate();
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.type === "hello")
          ws.send(
            JSON.stringify({
              type: "welcome",
              coordinatorVersion: "test",
              ackedHostSeq: 0,
              features: FEATURES,
            }),
          );
      });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    link = new CoordinatorLink({
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
      onCommand: () => {},
      log: silentLogger(),
    });
    cleanup.push(async () => {
      await link.stop();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    });
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
  });

  it("adds only explicit trusted option metadata, with no local binding or outbox record", async () => {
    const context = attestation();
    const work = link.requestAgent("ses1", "native1", "runtime1", "policy.evaluate", evaluation(), {
      toolCallId: "tool1",
      policyContext: context,
    });
    await vi.waitFor(() => expect(frames.some((f) => f.type === "agent.request")).toBe(true));
    const frame = frames.find((f) => f.type === "agent.request")!;
    expect(HostAgentRequestFrame.safeParse(frame).success).toBe(true);
    expect(frame.policyContext).toEqual(context);
    expect(frame.args).toEqual(evaluation());
    expect(frame).not.toHaveProperty("bindingId");
    expect(link.pending()).toEqual([]);
    socket.send(
      JSON.stringify({
        type: "agent.result",
        requestId: frame.requestId,
        runtimeId: frame.runtimeId,
        ok: true,
        result: { verdict: "ALLOW" },
      }),
    );
    await expect(work).resolves.toEqual({ verdict: "ALLOW" });
  });

  it("requires attestation only on policy.evaluate and never extracts it from args", async () => {
    await expect(
      link.requestAgent(
        "ses1",
        "native1",
        "runtime1",
        "policy.evaluate",
        { ...evaluation(), policyContext: attestation() },
        { toolCallId: "tool1" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      link.requestAgent(
        "ses1",
        "native1",
        "runtime1",
        "inbox.read",
        {},
        { policyContext: attestation() },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(frames.filter((f) => f.type === "agent.request")).toEqual([]);
  });

  it("enforces 128 KiB on enriched UTF-8 bytes and leaves the healthy link usable", async () => {
    const args = evaluation();
    args.tool.args = { text: "é".repeat(64_000) };
    const context = attestation(args);
    context.safety.reasons = ["x".repeat(1000), "y".repeat(1000), "z".repeat(1000)];
    const base = AgentRequestFrame.parse({
      type: "agent.request",
      requestId: randomUUID(),
      sessionId: "ses1",
      nativeSessionId: "native1",
      runtimeId: "runtime1",
      context: { humanInputId: null, causalMessageId: null },
      method: "policy.evaluate",
      toolCallId: "tool1",
      args,
    });
    expect(Buffer.byteLength(JSON.stringify(base))).toBeLessThan(AGENT_FRAME_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ ...base, policyContext: context }))).toBeGreaterThan(
      AGENT_FRAME_MAX_BYTES,
    );
    await expect(
      link.requestAgent("ses1", "native1", "runtime1", "policy.evaluate", args, {
        toolCallId: "tool1",
        policyContext: context,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(frames.filter((f) => f.type === "agent.request")).toEqual([]);
    expect(link.connected).toBe(true);
    const work = link.requestAgent("ses1", "native1", "runtime1", "inbox.read", {});
    await vi.waitFor(() => expect(frames.some((f) => f.type === "agent.request")).toBe(true));
    const frame = frames.find((f) => f.type === "agent.request")!;
    expect(frame).not.toHaveProperty("policyContext");
    socket.send(
      JSON.stringify({
        type: "agent.result",
        requestId: frame.requestId,
        runtimeId: frame.runtimeId,
        ok: true,
        result: { messages: [] },
      }),
    );
    await expect(work).resolves.toEqual({ messages: [] });
  });
});
