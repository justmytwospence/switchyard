import type { AgentRequestFrame, Profile, Session } from "@switchyard/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { MessageService } from "../src/agents/messages.js";
import { AgentService } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";

it("persists a depth denial across human reset and reevaluates a fresh tool call without spending quota", async () => {
  const db = openDb(":memory:");
  afterEach(() => db.close());
  migrate(db);
  const now = "2026-01-01T00:00:00.000Z";
  const store = new Store(db, new EventHub(), () => new Date(now));
  const profile: Profile = {
    id: "profile",
    name: "Test",
    provider: null,
    model: null,
    thinking: null,
    projectTrust: "ask",
    extraArgs: [],
  };
  store.hosts.upsert(
    {
      id: "host",
      name: "Test",
      platform: "darwin",
      agentVersion: "test",
      piVersion: "1.5.0",
      piCompatible: true,
      capabilities: null,
      connectivity: "connected",
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
    },
    { credential_hash: "hash" },
  );
  store.projects.upsert({
    id: "project",
    name: "Test",
    repoIdentity: "https://github.com/test/test",
    defaultProfileId: profile.id,
    defaultHostId: "host",
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  store.profiles.upsert(profile);
  const session = (id: string): Session => ({
    id,
    title: id,
    subtitle: null,
    hostId: "host",
    projectId: "project",
    workspaceId: null,
    cwd: "/repo",
    nativeHandle: { sessionId: `native-${id}`, sessionFile: `/sessions/${id}` },
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: now,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: now,
  });
  store.putSession(session("caller"));
  store.putSession(session("target"));
  const accept = vi.fn(async () => ({ state: "accepted" as const }));
  const messages = new MessageService(store, {
    isConnected: () => false,
    accept,
    status: async () => null,
  });
  const service = new AgentService({
    store,
    messages,
    negotiatedFeatures: () => new Set(["agentRequests.v1"]),
  });
  const base: AgentRequestFrame = {
    type: "agent.request",
    requestId: "request",
    sessionId: "caller",
    nativeSessionId: "native-caller",
    runtimeId: "runtime",
    context: { humanInputId: null, causalMessageId: null },
    method: "session.bind",
    args: {
      version: 1,
      sessionFile: "/sessions/caller",
      mode: "rpc",
      capabilities: {
        agentTools: true,
        messageDelivery: true,
        editorDraftGuard: true,
        toolPolicy: false,
      },
      policyRequired: false,
    },
  };
  expect(await service.handle("host", base)).toMatchObject({ ok: true });

  // Build a real depth-4 incoming chain; two messages already count against caller's pair quota.
  let causal: string | null = null;
  for (let depth = 0; depth <= 4; depth++) {
    const sender = depth % 2 === 0 ? "target" : "caller";
    const recipient = sender === "target" ? "caller" : "target";
    messages.recordContext(sender, { humanInputId: null, causalMessageId: causal });
    const message = messages.send(sender, {
      sessionId: recipient,
      body: `depth ${depth}`,
      mode: "queue",
    });
    expect(message.depth).toBe(depth);
    causal = message.id;
  }
  const request: AgentRequestFrame = {
    ...base,
    method: "message.send",
    toolCallId: "denied-call",
    deadlineAt: new Date(Date.parse(store.nowIso()) + 30_000).toISOString(),
    context: { humanInputId: null, causalMessageId: causal },
    args: { sessionId: "target", body: "reply", mode: "queue" },
  };
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const beforeMessages = rows("agent_messages");
  const beforeSubscriptions = rows("task_subscriptions");
  const first = await service.handle("host", request);
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: "invalid_request",
      message: "Reply limit reached. Wait for human input before continuing this exchange.",
    },
  });
  const receipts = rows("agent_call_receipts");
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    caller_session_id: "caller",
    native_session_id: "native-caller",
    tool_call_id: "denied-call",
    method: "message.send",
  });
  expect(rows("agent_messages")).toEqual(beforeMessages);
  expect(rows("task_subscriptions")).toEqual(beforeSubscriptions);
  expect(accept).not.toHaveBeenCalled();

  const reset = { humanInputId: "human-reset", causalMessageId: null };
  messages.recordContext("caller", reset);
  expect(await service.handle("host", { ...request, requestId: "retry", context: reset })).toEqual({
    ...first,
    requestId: "retry",
  });
  expect(rows("agent_call_receipts")).toEqual(receipts);
  expect(rows("agent_messages")).toEqual(beforeMessages);
  expect(rows("task_subscriptions")).toEqual(beforeSubscriptions);
  expect(accept).not.toHaveBeenCalled();

  // Eight remaining slots prove the failed call and its replay consumed no pair quota.
  for (let i = 0; i < 8; i++) {
    const result = await service.handle("host", {
      ...request,
      requestId: `fresh-${i}`,
      toolCallId: `fresh-${i}`,
      context: reset,
    });
    expect(result).toMatchObject({ ok: true, result: { message: { depth: 0 } } });
  }
  expect(
    await service.handle("host", {
      ...request,
      requestId: "over-quota",
      toolCallId: "over-quota",
      context: reset,
    }),
  ).toMatchObject({ ok: false, error: { code: "rate_limited" } });
});
