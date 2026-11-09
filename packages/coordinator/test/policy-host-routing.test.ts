import {
  AGENT_FRAME_MAX_BYTES,
  type AgentRequestFrame,
  type AgentResultFrame,
  type HostPolicyBoundary,
  type HostToolPolicyContext,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  workspaceRoot: "/repo",
  cwdReal: "/real/repo",
  workspaceRootReal: "/real/repo",
};
const proof: HostToolPolicyContext = {
  version: 1,
  toolCallId: "call",
  toolHash: "a".repeat(64),
  boundary,
  defaultBranch: null,
  safety: {
    destructiveDelete: false,
    forcePush: false,
    defaultBranchPush: false,
    uncertain: false,
    reasons: [],
  },
};

let t: TestCoordinator;
let host: FakeHost;
let hostId: string;
let credential: string;
let options: AgentServiceOptions;
let service: AgentService;
const hosts: FakeHost[] = [];

function frame(over: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: "req",
    sessionId: "ses_policy",
    nativeSessionId: "native",
    runtimeId: "runtime",
    context: { humanInputId: null, causalMessageId: null },
    method: "policy.evaluate",
    toolCallId: "call",
    args: { evaluationId: "evaluation", toolCallId: "call", tool: { name: "bash", args: {} } },
    ...over,
  };
}

function binding(over: Record<string, unknown> = {}): AgentRequestFrame {
  return frame({
    method: "session.bind",
    toolCallId: undefined,
    args: {
      version: 1,
      sessionFile: null,
      mode: "rpc",
      capabilities: {
        agentTools: true,
        messageDelivery: true,
        editorDraftGuard: true,
        toolPolicy: true,
      },
      policyRequired: true,
      controllerEpoch: "controller-policy",
      policyBoundary: boundary,
      ...over,
    },
  });
}

async function connect(features?: string[]) {
  const h = new FakeHost(t.c.localUrl.replace("http", "ws"), hostId, credential);
  hosts.push(h);
  await h.open({ features });
  return h;
}

async function result(h: FakeHost, request: unknown, requestId = "req") {
  h.sendRaw(request);
  return (await h.inbox.waitFor(
    (m) => m.type === "agent.result" && m.requestId === requestId,
  )) as AgentResultFrame;
}

// Top-level policy installation/advertisement is owned by a separate integration change.
// Simulate its negotiated connection here without changing production feature defaults.
function installNegotiatedPolicies() {
  const internals = t.c.hostHub as unknown as {
    conns: Map<string, { features: Set<string> }>;
  };
  internals.conns.get(hostId)!.features.add("policies.v1");
}

beforeEach(async () => {
  t = await startCoordinator();
  ({ hostId, credential } = await enrollHost(t));
  host = await connect(["agentRequests.v1", "policies.v1"]);
  await host.event("session.updated", hostSession("ses_policy", { cwd: "/repo" }));
  options = {
    store: t.c.store,
    scheduleDispatch: vi.fn(),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    bindPolicyBoundary: vi.fn(() => expect(t.c.store.inTransaction).toBe(true)),
    policyRequest: vi.fn(async () => ({ verdict: "ALLOW" })),
    onUnbind: vi.fn(),
  };
  service = new AgentService(options);
});

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  await t.cleanup();
});

describe("AgentService trusted policy boundary", () => {
  it("pins through the synchronous hook inside the authenticated bind transaction", async () => {
    expect(await service.handle(hostId, binding())).toMatchObject({
      ok: true,
      result: { features: ["agentRequests.v1", "policies.v1"] },
    });
    expect(options.bindPolicyBoundary).toHaveBeenCalledWith(
      {
        authenticatedHostId: hostId,
        sessionId: "ses_policy",
        nativeSessionId: "native",
        runtimeId: "runtime",
      },
      boundary,
    );
    expect(await service.handle(hostId, frame(), proof)).toMatchObject({ ok: true });
    expect(options.policyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ caller: expect.objectContaining({ hostId }) }),
      frame(),
      proof,
    );
  });

  it("requires a verified boundary and an installed hook only for negotiated tool policies", async () => {
    expect(await service.handle(hostId, binding({ policyBoundary: undefined }))).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_capability",
        message: "Required policy enforcement is unavailable.",
      },
    });
    expect(options.bindPolicyBoundary).not.toHaveBeenCalled();
    options.bindPolicyBoundary = undefined;
    expect(await service.handle(hostId, binding())).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    options.negotiatedFeatures = () => new Set(["agentRequests.v1"]);
    expect(await service.handle(hostId, binding({ policyBoundary: undefined }))).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(
      await service.handle(hostId, binding({ policyRequired: false, policyBoundary: undefined })),
    ).toMatchObject({
      ok: true,
      result: { features: ["agentRequests.v1"] },
    });
  });

  it("requires an epoch for protected bindings but accepts a legacy unprotected bridge", async () => {
    expect(await service.handle(hostId, binding({ controllerEpoch: undefined }))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    options.negotiatedFeatures = () => new Set(["agentRequests.v1"]);
    expect(
      await service.handle(
        hostId,
        binding({
          controllerEpoch: undefined,
          policyRequired: false,
          policyBoundary: undefined,
          capabilities: {
            agentTools: true,
            messageDelivery: true,
            editorDraftGuard: true,
            toolPolicy: false,
          },
        }),
      ),
    ).toMatchObject({ ok: true, result: { features: ["agentRequests.v1"] } });
  });

  it("keeps a non-policy bridge usable without the new optional hook or boundary", async () => {
    options.bindPolicyBoundary = undefined;
    expect(
      await service.handle(
        hostId,
        binding({
          policyRequired: false,
          policyBoundary: undefined,
          capabilities: {
            agentTools: true,
            messageDelivery: true,
            editorDraftGuard: true,
            toolPolicy: false,
          },
        }),
      ),
    ).toMatchObject({ ok: true, result: { features: ["agentRequests.v1"] } });
  });

  it("routes status without requiring or attaching tool proof", async () => {
    await service.handle(hostId, binding());
    const status = frame({
      method: "policy.status",
      toolCallId: undefined,
      args: { decisionId: "decision", waitMs: 25000 },
    });
    expect(await service.handle(hostId, status)).toMatchObject({ ok: true });
    expect(options.policyRequest).toHaveBeenCalledWith(expect.any(Object), status, undefined);
  });

  it.each([
    { ...boundary, cwd: "relative" },
    { ...boundary, cwdReal: "/real/repo-sibling" },
    { ...boundary, safety: {} },
  ])("rejects invalid bind attestations before the policy hook: %j", async (policyBoundary) => {
    expect(await service.handle(hostId, binding({ policyBoundary }))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(options.bindPolicyBoundary).not.toHaveBeenCalled();
  });

  it("rolls back a rejected boundary without replacing a previously bound runtime", async () => {
    expect(await service.handle(hostId, binding())).toMatchObject({ ok: true });
    options.bindPolicyBoundary = () => {
      t.c.store.setSetting("boundary-rollback-test", true);
      throw new SwitchyardError("conflict", "Cannot repin");
    };
    expect(await service.handle(hostId, { ...binding(), runtimeId: "next" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(t.c.store.getSetting("boundary-rollback-test", null)).toBeNull();
    expect(t.c.store.sessions.require("ses_policy").bridge?.runtimeId).toBe("runtime");
    expect(options.onUnbind).not.toHaveBeenCalled();
    expect(await service.handle(hostId, frame(), proof)).toMatchObject({ ok: true });
  });

  it("never promotes metadata in a base frame to trusted context", async () => {
    await service.handle(hostId, binding());
    expect(
      await service.handle(hostId, { ...frame(), policyContext: proof } as AgentRequestFrame),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await service.handle(hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await service.handle(hostId, frame({ method: "policy.status" }), proof)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(options.policyRequest).not.toHaveBeenCalled();
  });

  it("validates separate proof shape and applies the enriched cap even for direct service callers", async () => {
    await service.handle(hostId, binding());
    expect(await service.handle(hostId, frame(), { ...proof, toolHash: "invalid" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const base = frame({ args: { padding: "x".repeat(AGENT_FRAME_MAX_BYTES - 400) } });
    expect(Buffer.byteLength(JSON.stringify(base))).toBeLessThan(AGENT_FRAME_MAX_BYTES);
    expect(await service.handle(hostId, base, proof)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(options.policyRequest).not.toHaveBeenCalled();
  });

  it("preserves host ownership, runtime fencing and negotiated policy checks", async () => {
    await service.handle(hostId, binding());
    const other = await enrollHost(t, "other");
    expect(await service.handle(other.hostId, frame(), proof)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await service.handle(hostId, frame({ runtimeId: "obsolete" }), proof)).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    options.negotiatedFeatures = () => new Set(["agentRequests.v1"]);
    expect(await service.handle(hostId, frame(), proof)).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(options.policyRequest).not.toHaveBeenCalled();
  });
});

describe("HostHub authenticated attestation routing", () => {
  it("passes only a validated base frame and a separate host proof", async () => {
    installNegotiatedPolicies();
    const handler = vi.fn(async (_hostId: string, base: AgentRequestFrame) => ({
      type: "agent.result" as const,
      requestId: base.requestId,
      runtimeId: base.runtimeId,
      ok: true as const,
      result: null,
    }));
    t.c.hostHub.setAgentHandler(handler);
    expect(await result(host, { ...frame(), policyContext: proof })).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledWith(hostId, frame(), proof);
    expect(handler.mock.calls[0]![1]).not.toHaveProperty("policyContext");
  });

  it.each([
    { ...frame() },
    { ...frame(), policyContext: { ...proof, safety: { ...proof.safety, forged: true } } },
    { ...frame({ method: "policy.status" }), policyContext: proof },
    { ...frame(), policyContext: proof, authenticatedHostId: "forged" },
  ])("rejects forged/missing metadata without dropping the host: %j", async (request) => {
    const handler = vi.fn();
    t.c.hostHub.setAgentHandler(handler);
    expect(await result(host, request)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(handler).not.toHaveBeenCalled();
    await host.event("session.updated", hostSession("ses_still_connected"));
    expect(t.c.hostHub.isConnected(hostId)).toBe(true);
  });

  it("caps the enriched frame, not just the base request", async () => {
    const base = frame({ args: { padding: "x".repeat(AGENT_FRAME_MAX_BYTES - 400) } });
    expect(Buffer.byteLength(JSON.stringify(base))).toBeLessThan(AGENT_FRAME_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ ...base, policyContext: proof }))).toBeGreaterThan(
      AGENT_FRAME_MAX_BYTES,
    );
    const handler = vi.fn();
    t.c.hostHub.setAgentHandler(handler);
    expect(await result(host, { ...base, policyContext: proof })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(t.c.hostHub.isConnected(hostId)).toBe(true);
  });

  it("does not route a valid host proof for another host's session", async () => {
    installNegotiatedPolicies();
    const other = await enrollHost(t, "other-owner");
    const foreign = await FakeHost.connect(t, other);
    hosts.push(foreign);
    await foreign.event("session.updated", hostSession("ses_foreign"));
    const handler = vi.fn();
    t.c.hostHub.setAgentHandler(handler);
    expect(
      await result(host, { ...frame({ sessionId: "ses_foreign" }), policyContext: proof }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains legacy negotiation and rejects valid proofs without policy negotiation", async () => {
    const handler = vi.fn();
    t.c.hostHub.setAgentHandler(handler);
    const unprotected = await connect(["agentRequests.v1"]);
    expect(await result(unprotected, { ...frame(), policyContext: proof })).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    const old = await connect();
    expect(old.inbox.messages[0]).not.toHaveProperty("features");
    expect([...t.c.hostHub.negotiatedFeatures(hostId)]).toEqual([]);
    expect(await result(old, frame({ method: "inbox.read" }))).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not reply to a replaced authenticated socket after a slow policy request", async () => {
    installNegotiatedPolicies();
    let finish!: (response: AgentResultFrame) => void;
    const handler = vi.fn(
      () =>
        new Promise<AgentResultFrame>((resolve) => {
          finish = resolve;
        }),
    );
    t.c.hostHub.setAgentHandler(handler);
    host.sendRaw({ ...frame(), policyContext: proof });
    await until(() => handler.mock.calls.length === 1);
    const replacement = await connect(["agentRequests.v1"]);
    finish({
      type: "agent.result",
      requestId: "req",
      runtimeId: "runtime",
      ok: true,
      result: null,
    });
    // A command receipt is a round trip on the replacement after the handler has completed.
    await t.c.hostHub.request(hostId, {
      type: "session.abort",
      sessionId: "ses_policy",
      clearQueue: false,
    });
    expect(replacement.inbox.messages.some((m) => m.type === "agent.result")).toBe(false);
    expect(host.inbox.messages.some((m) => m.type === "agent.result")).toBe(false);
  });
});
