import {
  AGENT_FRAME_MAX_BYTES,
  type AgentRequestFrame,
  type AgentResultFrame,
  type Interaction,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSettled } from "../src/index.js";
import {
  enrollDevice,
  enrollHost,
  FakeClient,
  FakeHost,
  hostSession,
  NO_REPLY,
  sleep,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  await t?.cleanup();
  t = undefined;
});

async function connect(tc: TestCoordinator, creds: { hostId: string; credential: string }) {
  const h = new FakeHost(tc.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  await h.open({ features: undefined, capabilities: null, piVersion: "1.4.0" });
  hosts.push(h);
  return h;
}

async function connectAgent(
  tc: TestCoordinator,
  creds: { hostId: string; credential: string },
  features = ["agentRequests.v1", "policies.v1"],
) {
  const h = new FakeHost(tc.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  hosts.push(h);
  await h.open({ features });
  return h;
}

function agentRequest(
  requestId: string,
  overrides: Partial<AgentRequestFrame> = {},
): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId,
    sessionId: "ses_agent",
    nativeSessionId: "native_agent",
    runtimeId: "runtime_agent",
    context: { humanInputId: null, causalMessageId: null },
    method: "inbox.read",
    args: {},
    ...overrides,
  };
}

function agentResult(h: FakeHost, requestId: string): Promise<AgentResultFrame> {
  return h.inbox.waitFor(
    (m) => m.type === "agent.result" && m.requestId === requestId,
  ) as Promise<AgentResultFrame>;
}

function success(frame: AgentRequestFrame, result: unknown = null): AgentResultFrame {
  return {
    type: "agent.result",
    requestId: frame.requestId,
    runtimeId: frame.runtimeId,
    ok: true,
    result,
  };
}

function eventCount(tc: TestCoordinator, type: string): number {
  return (
    tc.c.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(type) as {
      n: number;
    }
  ).n;
}

describe("host link", () => {
  it("authenticates hello, welcomes with ackedHostSeq and marks the host connected", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    expect(h.inbox.messages[0]).toEqual({
      type: "welcome",
      coordinatorVersion: expect.any(String),
      ackedHostSeq: 0,
    });
    const host = t.c.store.hosts.require(creds.hostId);
    expect(host.connectivity).toBe("connected");
    expect(host.piVersion).toBe("1.4.0");
    expect(host.piCompatible).toBe(true);
  });

  it("negotiates only advertised known features, resetting them on replacement", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds, ["policies.v1", "unknown.v1", "agentRequests.v1"]);
    expect(h.inbox.messages[0]).toMatchObject({
      type: "welcome",
      features: ["agentRequests.v1", "policies.v1"],
    });
    expect([...t.c.hostHub.negotiatedFeatures(creds.hostId)]).toEqual([
      "agentRequests.v1",
      "policies.v1",
    ]);
    const old = await connect(t, creds);
    expect(old.inbox.messages[0]).not.toHaveProperty("features");
    expect([...t.c.hostHub.negotiatedFeatures(creds.hostId)]).toEqual([]);
    const empty = await connectAgent(t, creds, ["unknown.v1"]);
    expect(empty.inbox.messages[0]).toMatchObject({ type: "welcome", features: [] });
  });

  it("does not replay pending delivery commands to a legacy replacement", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    h.handler = () => NO_REPLY;
    const command = {
      type: "session.deliverMessage" as const,
      sessionId: "recipient",
      messageId: "message",
      payload: { deliveryId: "message", kind: "message" as const, text: "header" },
      mode: "queue" as const,
      holdUntil: new Date().toISOString(),
    };
    const pending = t.c.hostHub.request(creds.hostId, command);
    const failure = expect(pending).rejects.toMatchObject({ code: "unsupported_capability" });
    await until(() => h.commands.length === 1);
    await h.close();
    const legacy = await connect(t, creds);
    await failure;
    expect(legacy.commands).toHaveLength(0);
    await expect(t.c.hostHub.request(creds.hostId, command)).rejects.toMatchObject({
      code: "unsupported_capability",
    });
    await expect(
      t.c.hostHub.request(creds.hostId, {
        type: "session.messageStatus",
        sessionId: "recipient",
        messageIds: ["message"],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(legacy.commands).toHaveLength(0);
  });

  it("refuses protected launches on legacy hosts and sends protection to initialized capable hosts", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const command = {
      type: "session.start" as const,
      sessionId: "session",
      title: "Session",
      workspacePath: "/repo",
      projectId: null,
      profile: t.c.store.profiles.list()[0]!,
      nativeHandle: null,
      initialPrompt: null,
      dispatchKey: null,
      controlRevision: 1,
      controlMode: "human" as const,
      origin: "human" as const,
      readOnly: false,
    };
    await expect(
      t.c.hostHub.request(creds.hostId, { ...command, policyRequired: true }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await t.c.hostHub.request(creds.hostId, { ...command, policyRequired: false });
    expect(h.commands[0]!.command).not.toHaveProperty("policyRequired");
    const capable = await connectAgent(t, creds);
    await t.c.hostHub.request(creds.hostId, { ...command, policyRequired: true });
    expect(capable.commands[0]!.command).toMatchObject({ policyRequired: true });
  });

  it("checks negotiation and session ownership before invoking the injected agent handler", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const other = await enrollHost(t, "other");
    const owner = await connect(t, other);
    await owner.event("session.updated", hostSession("ses_foreign"));
    const old = await connect(t, creds);
    const handler = vi.fn(async (_hostId: string, frame: AgentRequestFrame) => success(frame));
    t.c.hostHub.setAgentHandler(handler);
    old.sendRaw(agentRequest("unnegotiated"));
    expect(await agentResult(old, "unnegotiated")).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    const h = await connectAgent(t, creds, ["agentRequests.v1"]);
    h.sendRaw(agentRequest("policy_unnegotiated", { method: "policy.evaluate" }));
    // Missing host proof is rejected during frame validation, before negotiation.
    expect(await agentResult(h, "policy_unnegotiated")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    h.sendRaw(agentRequest("foreign", { sessionId: "ses_foreign" }));
    expect(await agentResult(h, "foreign")).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    h.sendRaw(agentRequest("missing"));
    expect(await agentResult(h, "missing")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(handler).not.toHaveBeenCalled();
    await h.event("session.updated", hostSession("ses_agent"));
    const frame = agentRequest("valid", {
      context: { humanInputId: "human", causalMessageId: "message" },
    });
    h.sendRaw({ ...frame, hostId: other.hostId });
    expect(await agentResult(h, "valid")).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(handler).not.toHaveBeenCalled();
    const cleanFrame = { ...frame, requestId: "clean" };
    h.sendRaw(cleanFrame);
    expect(await agentResult(h, "clean")).toEqual(success(cleanFrame));
    expect(handler).toHaveBeenCalledExactlyOnceWith(creds.hostId, cleanFrame, undefined);
  });

  it("handles agent requests outside event projection and pending command receipts", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    await h.event("session.updated", hostSession("ses_agent"));
    let release!: (frame: AgentResultFrame) => void;
    const waiting = new Promise<AgentResultFrame>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (_hostId: string, frame: AgentRequestFrame) =>
      frame.requestId === "slow" ? waiting : success(frame, "fast"),
    );
    t.c.hostHub.setAgentHandler(handler);
    const slow = agentRequest("slow");
    h.sendRaw(slow);
    await until(() => handler.mock.calls.length === 1);
    await h.event("session.updated", { id: "ses_agent", runtime: "waiting_input" });
    expect(t.c.store.sessions.require("ses_agent").runtime).toBe("waiting_input");
    await expect(
      t.c.hostHub.request(creds.hostId, { type: "session.importable" }),
    ).resolves.toBeNull();
    h.sendRaw(agentRequest("fast"));
    expect(await agentResult(h, "fast")).toMatchObject({ ok: true, result: "fast" });
    expect(h.inbox.messages.some((m) => m.type === "agent.result" && m.requestId === "slow")).toBe(
      false,
    );
    release(success(slow, "finished"));
    expect(await agentResult(h, "slow")).toMatchObject({ ok: true, result: "finished" });
  });

  it("rejects unknown methods, malformed and oversized agent frames without dropping the host", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    await h.event("session.updated", hostSession("ses_agent"));
    const handler = vi.fn(async (_hostId: string, frame: AgentRequestFrame) => success(frame));
    t.c.hostHub.setAgentHandler(handler);
    for (const [id, overrides] of [
      ["unknown", { method: "unknown.method" }],
      ["invalid", { sessionId: "" }],
      ["missing_tool", { method: "task.create" }],
      ["oversized", { args: "é".repeat(AGENT_FRAME_MAX_BYTES / 2) }],
      ["extra_oversized", { ignored: "x".repeat(AGENT_FRAME_MAX_BYTES) }],
    ] as const) {
      h.sendRaw({ ...agentRequest(id), ...overrides });
      expect(await agentResult(h, id)).toMatchObject({
        requestId: id,
        runtimeId: "runtime_agent",
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    h.sendRaw({ type: "agent.request", requestId: "missing_runtime" });
    expect(handler).not.toHaveBeenCalled();
    await h.event("session.updated", { id: "ses_agent", title: "still healthy" });
    h.sendRaw(agentRequest("healthy"));
    expect(await agentResult(h, "healthy")).toMatchObject({ ok: true });
    expect(t.c.hostHub.isConnected(creds.hostId)).toBe(true);
  });

  it("returns bounded errors for unavailable, failing, malformed or oversized handlers", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    await h.event("session.updated", hostSession("ses_agent"));
    // A deliberately unwired hub still fails closed (production installs the builtin handler).
    t.c.hostHub.setAgentHandler(null);
    h.sendRaw(agentRequest("no_handler"));
    expect(await agentResult(h, "no_handler")).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    t.c.hostHub.setAgentHandler(async (_hostId, frame) => {
      if (frame.requestId === "forbidden")
        throw new SwitchyardError("forbidden", "denied", { reason: "test" });
      if (frame.requestId === "internal") throw new Error("private details");
      if (frame.requestId === "wrong_ids") return success({ ...frame, requestId: "other" });
      if (frame.requestId === "error_size")
        throw new SwitchyardError("internal", "large", "x".repeat(AGENT_FRAME_MAX_BYTES));
      return success(frame, "é".repeat(AGENT_FRAME_MAX_BYTES / 2));
    });
    for (const [id, code] of [
      ["forbidden", "forbidden"],
      ["internal", "internal"],
      ["wrong_ids", "internal"],
      ["large", "invalid_request"],
      ["error_size", "invalid_request"],
    ]) {
      h.sendRaw(agentRequest(id!));
      const result = await agentResult(h, id!);
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(AGENT_FRAME_MAX_BYTES);
      expect(JSON.stringify(result)).not.toContain("private details");
    }
  });

  it("does not send a delayed response to a replaced or revoked authenticated socket", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    await h.event("session.updated", hostSession("ses_agent"));
    const releases = new Map<string, (frame: AgentResultFrame) => void>();
    const handler = vi.fn(
      (_hostId: string, frame: AgentRequestFrame) =>
        new Promise<AgentResultFrame>((resolve) => releases.set(frame.requestId, resolve)),
    );
    t.c.hostHub.setAgentHandler(handler);
    h.sendRaw(agentRequest("replaced"));
    await until(() => releases.has("replaced"));
    const current = await connectAgent(t, creds);
    releases.get("replaced")!(success(agentRequest("replaced")));
    current.sendRaw(agentRequest("revoked"));
    await until(() => releases.has("revoked"));
    t.c.store.putHost({ ...t.c.store.hosts.require(creds.hostId), revokedAt: t.c.store.nowIso() });
    releases.get("revoked")!(success(agentRequest("revoked")));
    current.sendRaw(agentRequest("after_revocation"));
    await sleep(50);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      [...h.inbox.messages, ...current.inbox.messages].filter((m) => m.type === "agent.result"),
    ).toEqual([]);
  });

  it("projects bridge state and blocks all host changes to coordinator policy interactions", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connectAgent(t, creds);
    const bridge = {
      version: 1,
      runtimeId: "runtime_agent",
      nativeSessionId: "native-ses_agent",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    } as const;
    await h.event("session.updated", hostSession("ses_agent"));
    await h.event("session.updated", { id: "ses_agent", bridge });
    expect(t.c.store.sessions.require("ses_agent").bridge).toEqual({
      ...bridge,
      policyState: "unsupported",
      policyPhases: [],
    });
    const i: Interaction = {
      id: "int_policy",
      sessionId: "ses_agent",
      revision: 1,
      source: { kind: "extension_ui", method: "confirm", piRequestIds: [] },
      adapterId: null,
      title: "Allow?",
      presentation: { t: "text", text: "Allow?" },
      state: "pending",
      resolution: null,
      createdAt: t.c.store.nowIso(),
      permission: {
        kind: "policy",
        decisionId: "decision_a",
        rootTaskId: null,
        ruleId: "rule_a",
        ruleRevision: 1,
        fingerprint: "a".repeat(64),
      },
    };
    await h.event("interaction.updated", i);
    expect(t.c.store.interactions.get(i.id)).toBeUndefined();
    t.c.store.putInteraction(i, { hostId: creds.hostId });
    t.c.hostHub.reconcileInputAttention(i);
    expect(t.c.store.attention.list("resolved_at IS NULL")).toHaveLength(1);
    const { permission: _permission, ...withoutMarker } = i;
    await h.event("interaction.updated", { ...withoutMarker, state: "resolved", revision: 2 });
    await h.event("interaction.updated", { ...i, state: "resolved", revision: 2 });
    expect(t.c.store.interactions.require(i.id)).toEqual(i);
    expect(t.c.store.attention.list("resolved_at IS NULL")).toHaveLength(1);
    const resolved = { ...i, state: "resolved" as const, revision: 2 };
    t.c.store.putInteraction(resolved, { hostId: creds.hostId });
    t.c.hostHub.reconcileInputAttention(resolved);
    expect(t.c.store.attention.list("resolved_at IS NULL")).toHaveLength(0);
    const ordinary = { ...withoutMarker, id: "int_ordinary" };
    await h.event("interaction.updated", ordinary);
    expect(t.c.store.interactions.require(ordinary.id)).toEqual(ordinary);
  });

  it("rejects a bad credential", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, "wrong");
    hosts.push(h);
    const first = await h.open();
    expect(first).toMatchObject({ type: "reject", error: { code: "unauthorized" } });
    await until(() => h.closed);
  });

  it("projects events, dedupes by eventId and acks cumulatively", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_a"), { hostSeq: 1, eventId: "e1" });
    const s = t.c.store.sessions.require("ses_a");
    expect(s.hostId).toBe(creds.hostId);
    expect(s.connectivity).toBe("connected");
    expect(s.nativeHandle?.sessionFile).toBe("/tmp/native-ses_a.jsonl");

    const item = {
      id: "itm_1",
      sessionId: "ses_a",
      order: 0,
      at: new Date().toISOString(),
      kind: "user",
      data: { text: "hello" },
    };
    await h.event("transcript.item", item, { hostSeq: 2, eventId: "e2" });
    expect(eventCount(t, "transcript.item")).toBe(1);
    // Duplicate delivery (same eventId) is acked but not applied twice.
    await h.event("transcript.item", item, { hostSeq: 2, eventId: "e2" });
    expect(eventCount(t, "transcript.item")).toBe(1);
    expect(t.c.store.listItems("ses_a").items).toHaveLength(1);
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(2);

    // Invalid payloads are acked and recorded as a diagnostic, never wedging the link.
    await h.event("transcript.item", { bogus: true }, { hostSeq: 3, eventId: "e3" });
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(3);
    expect(eventCount(t, "diagnostic")).toBe(1);
  });

  it("persists ackedHostSeq across reconnects and coordinator restarts; replays dedupe", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    let h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_b"), { hostSeq: 1, eventId: "b1" });
    await h.event("session.updated", hostSession("ses_b", { title: "two" }), {
      hostSeq: 2,
      eventId: "b2",
    });
    await h.close();
    await until(() => t!.c.store.hosts.require(creds.hostId).connectivity === "reconnecting");
    expect(t.c.store.sessions.require("ses_b").connectivity).toBe("reconnecting");

    const dir = t.dir;
    await t.stop();
    t = await startCoordinator({ dir });
    h = await connect(t, creds);
    expect(h.inbox.messages[0]).toMatchObject({ type: "welcome", ackedHostSeq: 2 });
    // Host replays from its outbox: b2 again (already seen), then b3.
    const before = eventCount(t, "session.updated");
    await h.event("session.updated", hostSession("ses_b", { title: "two" }), {
      hostSeq: 2,
      eventId: "b2",
    });
    await h.event("session.updated", hostSession("ses_b", { title: "three" }), {
      hostSeq: 3,
      eventId: "b3",
    });
    expect(t.c.store.sessions.require("ses_b").title).toBe("three");
    expect(eventCount(t, "session.updated")).toBe(before + 1);
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(3);
  });

  it("goes reconnecting then unreachable after the timeout", async () => {
    t = await startCoordinator({ unreachableAfterMs: 150 });
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_c"), { hostSeq: 1 });
    await h.close();
    await until(() => t!.c.store.hosts.require(creds.hostId).connectivity === "reconnecting");
    await until(() => t!.c.store.hosts.require(creds.hostId).connectivity === "unreachable");
    expect(t.c.store.hosts.require(creds.hostId).connectivity).toBe("unreachable");
    expect(t.c.store.sessions.require("ses_c").connectivity).toBe("unreachable");
  });

  it("rejects commands while disconnected and resends pending commands on reconnect", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    await expect(
      t.c.hostHub.send(creds.hostId, { type: "session.importable" }),
    ).rejects.toMatchObject({ code: "host_unreachable" });

    let h = await connect(t, creds);
    h.handler = () => NO_REPLY;
    const pending = t.c.hostHub.request(creds.hostId, { type: "session.importable" });
    const first = await h.waitForCommand("session.importable");
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));

    h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(h);
    h.handler = () => [{ fake: true }];
    await h.open();
    const resent = await h.waitForCommand("session.importable");
    expect(resent.commandId).toBe(first.commandId);
    await expect(pending).resolves.toEqual([{ fake: true }]);
  });

  it("withdrawMatching drops matching pending commands of a disconnected host only", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    let h = await connect(t, creds);
    h.handler = () => NO_REPLY;
    const matching = t.c.hostHub.request(
      creds.hostId,
      { type: "session.importable" },
      { commandId: "cont_run_x_1" },
    );
    const other = t.c.hostHub.request(
      creds.hostId,
      { type: "session.importable" },
      { commandId: "other_1" },
    );
    const matchingResult = matching.catch((e) => e);
    await until(() => h.commands.length === 2);
    const isCont = (id: string) => id.startsWith("cont_run_x_");
    expect(t.c.hostHub.withdrawMatching(creds.hostId, isCont, "withdrawn")).toBe(0);
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    expect(t.c.hostHub.withdrawMatching(creds.hostId, isCont, "withdrawn")).toBe(1);
    expect(await matchingResult).toMatchObject({
      code: "host_unreachable",
      details: { withdrawn: true },
    });

    h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(h);
    h.handler = () => [];
    await h.open();
    await expect(other).resolves.toEqual([]);
    expect(h.commands.map((c) => c.commandId)).toEqual(["other_1"]);
  });

  it("maps error receipts to SwitchyardError and times out silent hosts", async () => {
    t = await startCoordinator({ commandTimeoutMs: 200 });
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    h.handler = (cmd) =>
      cmd.type === "checkout.inspect"
        ? { __error: { code: "not_a_git_repo", message: "nope" } }
        : NO_REPLY;
    await expect(
      t.c.hostHub.request(creds.hostId, { type: "checkout.inspect", path: "/x" }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
    await expect(
      t.c.hostHub.request(creds.hostId, { type: "session.importable" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("emits session.settled when a session goes from running to idle", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const settled: SessionSettled[] = [];
    t.c.events.on("session.settled", (s) => {
      settled.push(s);
    });
    await h.event("session.updated", hostSession("ses_d", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_d", { runtime: "waiting_input" }));
    expect(settled).toHaveLength(0);
    await h.event(
      "session.updated",
      hostSession("ses_d", { runtime: "idle", lastAssistantText: "done\nSWITCHYARD: DONE" }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.previousRuntime).toBe("waiting_input");
    expect(settled[0]!.lastAssistantText).toContain("SWITCHYARD: DONE");
    expect(settled[0]!.aborted).toBe(false);
  });

  it("marks a finished or failed session unread unless a foreground viewer has it open", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const dev = await enrollDevice(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_u", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_u", { runtime: "idle" }));
    expect(t.c.store.sessions.get("ses_u")?.unreadSince).toBeTruthy();

    await h.event("session.updated", hostSession("ses_f", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_f", { runtime: "failed" }));
    expect(t.c.store.sessions.get("ses_f")?.unreadSince).toBeTruthy();

    t.c.store.upsertPresence({
      deviceId: dev.deviceId,
      foregroundUntil: new Date(t.clock.now + 30_000).toISOString(),
      interactedAt: null,
      viewingSessionId: "ses_v",
      updatedAt: new Date(t.clock.now).toISOString(),
    });
    await h.event("session.updated", hostSession("ses_v", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_v", { runtime: "idle" }));
    expect(t.c.store.sessions.get("ses_v")?.unreadSince ?? null).toBeNull();
  });

  it("projects promptCache from the host and keeps cacheAlert and transcriptEpoch", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_p", {}));
    t.c.store.putSession({
      ...t.c.store.sessions.require("ses_p"),
      cacheAlert: { ttlSec: null, warnedFor: null },
      transcriptEpoch: 3,
    });
    const pc = {
      at: "2026-01-01T00:00:00.000Z",
      provider: "anthropic",
      model: "m",
      cacheRead: 1,
      cacheWrite: 2,
      cacheWrite1h: 0,
    };
    await h.event("session.updated", hostSession("ses_p", { promptCache: pc }));
    const s = t.c.store.sessions.require("ses_p");
    expect(s.promptCache).toEqual(pc);
    expect(s.cacheAlert).toEqual({ ttlSec: null, warnedFor: null });
    expect(s.transcriptEpoch).toBe(3);
  });

  it("stores host usage and ignores a repeat that differs only by fetchedAt", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const usage = (fetchedAt: string) => [
      {
        provider: "anthropic",
        status: "available",
        message: null,
        windows: [{ id: "five_hour", usedPct: 12, resetsAt: null }],
        fetchedAt,
      },
    ];
    h.sendRaw({ type: "usage", usage: usage("2026-11-01T10:00:00.000Z") });
    await until(() => (t!.c.store.hosts.get(creds.hostId)?.usage?.length ?? 0) === 1);
    const before = eventCount(t, "host.updated");
    h.sendRaw({ type: "usage", usage: usage("2026-11-01T10:05:00.000Z") });
    await sleep(100);
    expect(eventCount(t, "host.updated")).toBe(before);
  });

  it("emits host.connected with reconnect flag", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const seen: boolean[] = [];
    t.c.events.on("host.connected", (e) => {
      seen.push(e.reconnect);
    });
    let h = await connect(t, creds);
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    h = await connect(t, creds);
    expect(seen).toEqual([false, true]);
  });

  it("keeps coordinator-owned session fields when the host updates a session", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_e"));
    const s = t.c.store.sessions.require("ses_e");
    t.c.store.putSession({ ...s, projectId: "prj_x", taskId: "tsk_x" } as Session);
    await h.event(
      "session.updated",
      hostSession("ses_e", { runtime: "running", nativeHandle: null }),
    );
    const after = t.c.store.sessions.require("ses_e");
    expect(after.projectId).toBe("prj_x");
    expect(after.taskId).toBe("tsk_x");
    expect(after.runtime).toBe("running");
    expect(after.nativeHandle?.sessionFile).toBe("/tmp/native-ses_e.jsonl");
  });

  it("forwards stream deltas to clients without persisting them", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const dev = await enrollDevice(t);
    const client = await FakeClient.connect(t, { token: dev.credential });
    await client.hello(null);
    const seqBefore = t.c.store.currentSeq();
    h.sendRaw({
      type: "stream",
      delta: { sessionId: "ses_s", itemId: "itm_s", kind: "text", delta: "Hel" },
    });
    const m = await client.inbox.waitFor((x) => x.type === "stream");
    expect(m).toMatchObject({ type: "stream", delta: { delta: "Hel" } });
    await sleep(20);
    expect(t.c.store.currentSeq()).toBe(seqBefore);
    client.close();
  });

  it("serves adapter renderers with sandbox CSP from adapters.updated", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const adapter = {
      id: "bg",
      version: "1.0.0",
      tier: "bundled",
      target: { extension: "@x/pi-bg", versionRange: "*", testedVersions: [] },
      capabilities: ["panels"],
      webRenderer: true,
      status: "active",
      detail: null,
    };
    await h.event("adapters.updated", {
      hostId: creds.hostId,
      adapters: [adapter],
      renderers: { bg: "<html><body>bg</body></html>" },
    });
    const r = await t.admin("GET", `/adapter-frames/${creds.hostId}/bg`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("bg</body>");
    expect(r.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts;/);
    expect(r.headers.get("content-security-policy")).not.toMatch(/allow-same-origin/);
    expect((await t.admin("GET", `/adapter-frames/${creds.hostId}/nope`)).status).toBe(404);
    expect((await t.api("GET", `/adapter-frames/${creds.hostId}/bg`)).status).toBe(401);
    const host = await t.admin("GET", `/api/hosts/${creds.hostId}`);
    expect(host.body.adapters).toHaveLength(1);
  });
});
