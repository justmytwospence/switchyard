import { createHash } from "node:crypto";
import { request } from "node:http";
import {
  type AgentRequestFrame,
  type AgentResultFrame,
  AgentToolPolicyWait,
  canonicalPolicyJson,
  type HostPolicyBoundary,
  type HostToolPolicyContext,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import { requireService } from "../src/services.js";
import {
  enrollDevice,
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
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
const safety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [] as string[],
};
let t: TestCoordinator;
let host: FakeHost;
let hostId: string;
let hostCredential: string;
let counter = 0;
const policies = () => requireService(t.c.ctx, "policies");
const agents = () => requireService(t.c.ctx, "agents");
const owner = () => ({
  authenticatedHostId: hostId,
  sessionId: "ses_policy_wiring",
  nativeSessionId: "native",
  runtimeId: "runtime",
});
function frame(over: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: `request-${++counter}`,
    sessionId: "ses_policy_wiring",
    nativeSessionId: "native",
    runtimeId: "runtime",
    context: { humanInputId: null, causalMessageId: null },
    method: "inbox.read",
    toolCallId: `call-${counter}`,
    deadlineAt: new Date(t.clock.now + 30_000).toISOString(),
    args: {},
    ...over,
  };
}
function binding(runtimeId = "runtime") {
  return frame({
    method: "session.bind",
    toolCallId: undefined,
    runtimeId,
    args: {
      version: 1,
      sessionFile: "/sessions/native.jsonl",
      mode: "rpc",
      capabilities: {
        agentTools: true,
        messageDelivery: true,
        editorDraftGuard: true,
        toolPolicy: true,
      },
      policyRequired: true,
      controllerEpoch: "d56b0e03-6291-4bd1-b334-d924e559687f",
      policyBoundary: boundary,
    },
  });
}
// Observe the actual initialized handshake; tests must not mutate negotiated features.
function negotiatedFeatures(): Set<string> {
  return (t.c.hostHub as unknown as { conns: Map<string, { features: Set<string> }> }).conns.get(
    hostId,
  )!.features;
}
async function bind() {
  expect(negotiatedFeatures().has("policies.v1")).toBe(true);
  const spy = vi.spyOn(policies(), "bindBoundary");
  expect(await agents().handle(hostId, binding())).toMatchObject({
    ok: true,
    result: { features: ["agentRequests.v1", "policies.v1"] },
  });
  expect(spy).toHaveBeenCalledWith(owner(), boundary);
  const session = t.c.store.sessions.require("ses_policy_wiring");
  t.c.store.putSession({
    ...session,
    bridge: { ...session.bridge!, policyState: "active", policyPhases: ["tool_call", "request"] },
  });
}
async function askRule(name: string, priority: number) {
  return policies().createRule({
    scope: "server",
    scopeId: null,
    priority,
    enabled: true,
    phases: ["request"],
    name,
    expression: `{"verdict":"ASK","reason":"${name}"}`,
  });
}
function pending() {
  return t.c.store.interactions.list("state = 'pending'");
}
function receipts() {
  return t.c.store.db.prepare("SELECT * FROM agent_call_receipts").all();
}
function retry(request: AgentRequestFrame): AgentRequestFrame {
  return {
    ...request,
    requestId: `request-${++counter}`,
    deadlineAt: new Date(t.clock.now + 30_000).toISOString(),
  };
}
async function required(request: AgentRequestFrame) {
  const result = await agents().handle(hostId, request);
  expect(result).toMatchObject({ ok: true, result: { type: "policy.required" } });
  if (!result.ok) throw new Error("Expected a nonfinal policy wait");
  return AgentToolPolicyWait.parse(result.result);
}
function status(decisionId: string) {
  return agents().handle(
    hostId,
    frame({
      method: "policy.status",
      toolCallId: undefined,
      args: { decisionId, waitMs: 25000 },
    }),
  );
}
function expectNoExecution() {
  expect(requireService(t.c.ctx, "messages").readInbox).not.toHaveBeenCalled();
  expect(receipts()).toHaveLength(0);
}
async function answer(id: string, confirmed = true) {
  return t.admin("POST", `/api/interactions/${id}/answer`, {
    revision: t.c.store.interactions.require(id).revision,
    response: { kind: "confirm", confirmed },
  });
}

beforeEach(async () => {
  t = await startCoordinator({
    schedulerTickMs: 0,
    projectScanIntervalMs: 0,
    cacheAlertTickMs: 0,
  });
  const credentials = await enrollHost(t);
  hostId = credentials.hostId;
  hostCredential = credentials.credential;
  host = new FakeHost(t.c.localUrl.replace("http", "ws"), hostId, credentials.credential);
  await host.open({ features: ["agentRequests.v1", "policies.v1"] });
  await host.event("session.updated", hostSession("ses_policy_wiring", { cwd: "/repo" }));
  vi.spyOn(requireService(t.c.ctx, "messages"), "readInbox");
});
afterEach(async () => {
  await host.close();
  await t.cleanup();
  vi.restoreAllMocks();
});

describe("coordinator policy installation", () => {
  it("registers authenticated routes and advertises enforcement after initialization", async () => {
    expect(policies().ready).toBe(true);
    expect(negotiatedFeatures().has("policies.v1")).toBe(true);
    expect(
      policies()
        .listRules()
        .some((r) => r.builtIn),
    ).toBe(true);
    for (const path of ["/api/policies", "/api/policies/settings"]) {
      expect((await t.api("GET", path)).status).toBe(401);
      expect((await t.admin("GET", path)).status).toBe(200);
    }
    expect((await t.api("POST", "/api/policies/test", { body: {} })).status).toBe(401);
    expect((await t.admin("POST", "/api/policies/test", {})).status).toBe(400);
    expect((await t.api("POST", "/api/policies", { token: hostCredential, body: {} })).status).toBe(
      401,
    );
    const created = await t.admin("POST", "/api/policies", {
      scope: "server",
      scopeId: null,
      priority: 0,
      enabled: true,
      phases: ["request"],
      name: "No match",
      expression: "null",
    });
    expect(created.status).toBe(201);
    expect(
      (await t.admin("DELETE", `/api/policies/${created.body.id}?expectedRevision=1`)).status,
    ).toBe(200);
  });

  it("rejects a protected bind without its host-generated controller epoch", async () => {
    const request = binding();
    const args = { ...request.args };
    delete args.controllerEpoch;
    expect(await agents().handle(hostId, { ...request, args })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("returns ASK immediately and executes only an explicit same-call retry after all questions allow", async () => {
    await bind();
    await askRule("first", -2);
    await askRule("second", -1);
    const request = frame();
    const wait = await required(request);
    const first = pending()[0]!;
    expect(first.permission).toMatchObject({ kind: "policy", decisionId: wait.decisionId });
    expect(first.id).toBe(wait.interactionId);
    expectNoExecution();
    const firstStatus = status(wait.decisionId);
    // A healthy approval wait may outlive the original tool RPC's fixed deadline.
    t.clock.advance(31_000);
    expect((await answer(first.id)).status).toBe(200);
    expect(await firstStatus).toMatchObject({ ok: true, result: { state: "pending" } });
    const second = pending()[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.permission?.decisionId).toBe(wait.decisionId);
    const secondWait = await required(retry(request));
    expect(secondWait).toMatchObject({ decisionId: wait.decisionId, interactionId: second.id });
    expect(pending()).toHaveLength(1);
    expectNoExecution();
    expect((await answer(second.id)).status).toBe(200);
    expect(await status(wait.decisionId)).toMatchObject({ ok: true, result: { state: "allowed" } });
    expectNoExecution();
    // Neither approval nor status can awaken the original, now-expired request.
    expect(await agents().handle(hostId, request)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expectNoExecution();
    const resumed = retry(request);
    expect(resumed.requestId).not.toBe(request.requestId);
    expect(resumed.deadlineAt).not.toBe(request.deadlineAt);
    const result = await agents().handle(hostId, resumed);
    expect(result).toMatchObject({ ok: true, result: { messages: [] } });
    expect(receipts()).toHaveLength(1);
    expect(requireService(t.c.ctx, "messages").readInbox).toHaveBeenCalledOnce();
    const replay = retry(request);
    expect(await agents().handle(hostId, replay)).toEqual({
      ...result,
      requestId: replay.requestId,
    });
    expect(receipts()).toHaveLength(1);
    expect(requireService(t.c.ctx, "messages").readInbox).toHaveBeenCalledOnce();
    expect(t.c.store.attention.list("resolved_at IS NULL")).toHaveLength(0);
  });

  it("does not execute on DENY, canceled decisions, or policy failures", async () => {
    await bind();
    const authorize = vi.spyOn(policies(), "authorize");
    const statusSpy = vi.spyOn(policies(), "status");
    authorize.mockResolvedValueOnce({ verdict: "DENY", reason: "denied" });
    expect(await agents().handle(hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "denied" },
    });
    expect(receipts()).toHaveLength(1);
    await askRule("cancel", 0);
    const request = frame();
    const wait = await required(request);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(
      await agents().handle(
        hostId,
        frame({
          method: "policy.cancel",
          toolCallId: undefined,
          args: { decisionId: wait.decisionId },
        }),
      ),
    ).toMatchObject({ ok: true, result: { state: "canceled" } });
    expect(await status(wait.decisionId)).toMatchObject({
      ok: true,
      result: { state: "canceled" },
    });
    expect(statusSpy).toHaveBeenCalledOnce();
    expect(statusSpy).toHaveBeenCalledWith(
      owner(),
      { decisionId: wait.decisionId, waitMs: 25000 },
      expect.any(AbortSignal),
    );
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    authorize.mockRejectedValueOnce(new SwitchyardError("timeout", "unavailable"));
    expect(await agents().handle(hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(requireService(t.c.ctx, "messages").readInbox).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(1);
    expect(t.c.store.db.prepare("SELECT * FROM policy_grants").all()).toHaveLength(0);
  });

  it("revalidates context after the retry's final ALLOW before the agent transaction", async () => {
    await bind();
    await askRule("revalidate", 0);
    const request = frame();
    const wait = await required(request);
    expect((await answer(wait.interactionId)).status).toBe(200);
    expect(await status(wait.decisionId)).toMatchObject({ ok: true, result: { state: "allowed" } });
    expectNoExecution();
    const authorize = policies().authorize.bind(policies());
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
      const evaluation = await authorize(input);
      expect(evaluation).toEqual({ verdict: "ALLOW" });
      const session = t.c.store.sessions.require("ses_policy_wiring");
      t.c.store.putSession({ ...session, cwd: "/other" });
      return evaluation;
    });
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expectNoExecution();
  });

  it("cancels an old runtime's pending authorization on rebind", async () => {
    await bind();
    await askRule("wait", 0);
    const request = frame();
    const wait = await required(request);
    const interaction = t.c.store.interactions.require(wait.interactionId);
    expectNoExecution();
    const cancel = vi.spyOn(policies(), "cancelForSession");
    expect(await agents().handle(hostId, binding("new-runtime"))).toMatchObject({ ok: true });
    expect(cancel).toHaveBeenCalledWith("ses_policy_wiring", "runtime");
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect((await answer(interaction.id)).status).toBe(409);
    expect(t.c.store.interactions.require(interaction.id).state).toBe("canceled");
    expect(pending()).toHaveLength(0);
    expectNoExecution();
  });

  it("drains explicit policy status waits and closes the evaluator on coordinator shutdown", async () => {
    await bind();
    await askRule("shutdown", 0);
    const close = vi.spyOn(PolicyEvaluator.prototype, "close");
    const wait = await required(frame());
    expectNoExecution();
    const statusSpy = vi.spyOn(policies(), "status");
    const waiting = status(wait.decisionId);
    expect(statusSpy).toHaveBeenCalledWith(
      owner(),
      { decisionId: wait.decisionId, waitMs: 25000 },
      expect.any(AbortSignal),
    );
    await t.stop();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "host_unreachable" } });
    expect(requireService(t.c.ctx, "messages").readInbox).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("authenticated policy request and answer routing", () => {
  it("rejects malformed owned status/cancel arguments as invalid_request, not a policy success", async () => {
    await bind();
    const status = vi.spyOn(policies(), "status");
    const cancel = vi.spyOn(policies(), "cancel");
    for (const method of ["policy.status", "policy.cancel"] as const) {
      expect(
        await agents().handle(hostId, frame({ method, args: {}, toolCallId: undefined })),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    expect(status).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("passes separate host proof through the production HostHub callback and routes owned status/cancel", async () => {
    await bind();
    const request = frame({ method: "policy.evaluate" });
    const tool = { name: "bash", args: { command: "echo safe" } };
    request.args = {
      toolCallId: request.toolCallId,
      evaluationId: `pol_${createHash("sha256")
        .update(
          JSON.stringify([
            request.sessionId,
            request.nativeSessionId,
            "tool_call",
            request.toolCallId,
          ]),
        )
        .digest("hex")}`,
      tool,
    };
    const proof: HostToolPolicyContext = {
      version: 1,
      toolCallId: request.toolCallId!,
      toolHash: createHash("sha256").update(canonicalPolicyJson(tool)).digest("hex"),
      boundary,
      defaultBranch: null,
      safety,
    };
    const authorize = vi.spyOn(policies(), "authorize");
    host.sendRaw({ ...request, policyContext: proof });
    const result = (await host.inbox.waitFor(
      (m) => m.type === "agent.result" && m.requestId === request.requestId,
    )) as AgentResultFrame;
    expect(result).toMatchObject({ ok: true, result: { verdict: "ALLOW" } });
    expect(authorize).toHaveBeenCalledWith({
      kind: "tool",
      owner: owner(),
      frame: request,
      hostContext: proof,
      signal: expect.any(AbortSignal),
    });
    expect(authorize.mock.calls[0]![0]).not.toHaveProperty("frame.policyContext");
    const status = vi.spyOn(policies(), "status").mockResolvedValue({ state: "pending" });
    const cancel = vi.spyOn(policies(), "cancel").mockReturnValue({ state: "canceled" });
    expect(
      await agents().handle(
        hostId,
        frame({
          method: "policy.status",
          args: { decisionId: "owned", waitMs: 25000 },
          toolCallId: undefined,
        }),
      ),
    ).toMatchObject({ ok: true, result: { state: "pending" } });
    expect(status).toHaveBeenCalledWith(
      owner(),
      { decisionId: "owned", waitMs: 25000 },
      expect.any(AbortSignal),
    );
    expect(
      await agents().handle(
        hostId,
        frame({ method: "policy.cancel", args: { decisionId: "owned" }, toolCallId: undefined }),
      ),
    ).toMatchObject({ ok: true, result: { state: "canceled" } });
    expect(cancel).toHaveBeenCalledWith(owner(), { decisionId: "owned" });
  });

  it("preserves the already_answered response for concurrent policy answers and blocks a declined action", async () => {
    await bind();
    await askRule("decline", 0);
    const request = frame();
    const wait = await required(request);
    const interaction = t.c.store.interactions.require(wait.interactionId);
    expectNoExecution();
    const body = {
      revision: interaction.revision,
      response: { kind: "confirm", confirmed: false },
    };
    const responses = await Promise.all([
      t.admin("POST", `/api/interactions/${interaction.id}/answer`, body),
      t.admin("POST", `/api/interactions/${interaction.id}/answer`, body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.status === 409)!.body.error).toMatchObject({
      code: "already_answered",
      details: { interaction: { state: "resolved" } },
    });
    expect(await status(wait.decisionId)).toMatchObject({ ok: true, result: { state: "denied" } });
    expectNoExecution();
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(requireService(t.c.ctx, "messages").readInbox).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(1);
    expect(t.c.store.db.prepare("SELECT * FROM policy_grants").all()).toHaveLength(0);
  });

  it("answers offline permissions as the authenticated device, not through the host, and preserves once-only semantics", async () => {
    await bind();
    await askRule("offline", 0);
    const device = await enrollDevice(t);
    const request = frame();
    const wait = await required(request);
    const interaction = t.c.store.interactions.require(wait.interactionId);
    expectNoExecution();
    await host.close();
    await until(() => !t.c.hostHub.isConnected(hostId));
    const path = `/api/interactions/${interaction.id}/answer`;
    const body = { revision: interaction.revision, response: { kind: "confirm", confirmed: true } };
    expect((await t.api("POST", path, { body })).status).toBe(401);
    expect(
      (
        await t.api("POST", path, {
          token: device.credential,
          body: { revision: interaction.revision, response: { kind: "action", actionId: "allow" } },
        })
      ).status,
    ).toBe(400);
    const answered = await t.api("POST", path, { token: device.credential, body });
    expect(answered.status).toBe(200);
    expect(answered.body.interaction.resolution.by).toBe(device.deviceId);
    expect((await t.api("POST", path, { token: device.credential, body })).body.error.code).toBe(
      "already_answered",
    );
    expect(host.commands.some(({ command }) => command.type === "session.answer")).toBe(false);
    // An offline answer grants authority but cannot execute an orphaned request.
    expectNoExecution();
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: false,
      error: { code: "host_unreachable" },
    });
    expectNoExecution();
    expect(t.c.store.db.prepare("SELECT approved_by_device_id FROM policy_grants").get()).toEqual({
      approved_by_device_id: device.deviceId,
    });
    // A reconnected runtime must explicitly retry the same logical call and revalidate.
    host = new FakeHost(t.c.localUrl.replace("http", "ws"), hostId, hostCredential);
    await host.open({ features: ["agentRequests.v1", "policies.v1"] });
    expect(await status(wait.decisionId)).toMatchObject({ ok: true, result: { state: "allowed" } });
    expectNoExecution();
    expect(await agents().handle(hostId, retry(request))).toMatchObject({
      ok: true,
      result: { messages: [] },
    });
    expect(receipts()).toHaveLength(1);
    expect(requireService(t.c.ctx, "messages").readInbox).toHaveBeenCalledOnce();
  });
});

describe("read-only policy sample host wiring", () => {
  it("propagates tester client disconnect cancellation without creating authorization state", async () => {
    await bind();
    const test = vi.spyOn(policies(), "test");
    host.handler = async () => NO_REPLY;
    const controller = new AbortController();
    const client = request(`${t.c.localUrl}/api/policies/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.c.adminToken}`, "content-type": "application/json" },
      agent: false,
      signal: controller.signal,
    });
    let error: Error | undefined;
    let receivedResponse = false;
    let socket: typeof client.socket;
    let socketClosed: Promise<void> = Promise.resolve();
    client.on("error", (err) => {
      error = err;
    });
    client.on("response", (response) => {
      receivedResponse = true;
      response.resume();
    });
    client.on("socket", (assigned) => {
      socket = assigned;
      socketClosed = new Promise((resolve) => assigned.once("close", resolve));
    });
    const closed = new Promise<void>((resolve) => client.once("close", resolve));
    try {
      client.end(
        JSON.stringify({
          sessionId: "ses_policy_wiring",
          phase: "tool_call",
          tool: { name: "bash", args: { command: "echo safe" } },
          request: null,
        }),
      );
      await host.waitForCommand("session.classifyPolicySample");
      controller.abort();
      await closed;
      expect(receivedResponse).toBe(false);
      expect(error?.name).toBe("AbortError");
      await until(() => test.mock.calls[0]?.[1]?.signal?.aborted === true);
      expect(t.c.store.db.prepare("SELECT * FROM policy_evaluations").all()).toHaveLength(0);
      expect(pending()).toHaveLength(0);
    } finally {
      client.destroy();
      socket?.destroy();
      await closed;
      await socketClosed;
    }
  });

  it("routes a sample to the stored owning host with negotiated policies and a 10-second timeout", async () => {
    await bind();
    const request = vi.spyOn(t.c.hostHub, "request");
    host.handler = async (command) => {
      if (command.type !== "session.classifyPolicySample") return null;
      return {
        sessionId: command.sessionId,
        nativeSessionId: command.nativeSessionId,
        runtimeId: command.runtimeId,
        sampleId: command.sampleId,
        toolHash: createHash("sha256").update(canonicalPolicyJson(command.tool)).digest("hex"),
        boundary,
        defaultBranch: "trunk",
        safety: { ...safety, destructiveDelete: true },
      };
    };
    const before = t.c.store.db.prepare("SELECT * FROM policy_evaluations").all();
    const result = await t.admin("POST", "/api/policies/test", {
      sessionId: "ses_policy_wiring",
      phase: "tool_call",
      tool: { name: "bash", args: { command: "rm -rf /outside" } },
      request: null,
    });
    expect(result.status).toBe(200);
    expect(result.body.verdict).toBe("ASK");
    expect(request).toHaveBeenCalledWith(
      hostId,
      expect.objectContaining({
        type: "session.classifyPolicySample",
        sessionId: "ses_policy_wiring",
        runtimeId: "runtime",
        nativeSessionId: "native",
      }),
      { timeoutMs: 10000 },
    );
    expect(t.c.store.db.prepare("SELECT * FROM policy_evaluations").all()).toEqual(before);
    expect(pending()).toHaveLength(0);
    expect(host.commands.map(({ command }) => command.type)).toEqual([
      "session.classifyPolicySample",
    ]);
  });

  it("rejects unnegotiated sample classification instead of sending a new command to an old host", async () => {
    await bind();
    negotiatedFeatures().delete("policies.v1");
    const request = vi.spyOn(t.c.hostHub, "request");
    const result = await t.admin("POST", "/api/policies/test", {
      sessionId: "ses_policy_wiring",
      phase: "tool_call",
      tool: { name: "bash", args: { command: "echo safe" } },
      request: null,
    });
    expect(result.body.error.code).toBe("unsupported_capability");
    expect(request).not.toHaveBeenCalled();
  });
});
