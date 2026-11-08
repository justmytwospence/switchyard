import type { AgentMessage, DeliveryState, Session } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_PAGE_BYTES,
  MESSAGE_HOLD_MS,
  type MessageDeliveryTransport,
  MessageService,
  messageSenderTitle,
  ordinaryMessageHeader,
} from "../src/agents/messages.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";

const resources: { service: MessageService; db: ReturnType<typeof openDb> }[] = [];
afterEach(async () => {
  for (const { service, db } of resources.splice(0)) {
    await service.stop();
    db.close();
  }
  vi.useRealTimers();
});

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new Store(db, new EventHub(), () => new Date(now));
  const transport = {
    isConnected: vi.fn(() => true),
    accept: vi.fn<MessageDeliveryTransport["accept"]>(async () => ({ state: "accepted" })),
    status: vi.fn<MessageDeliveryTransport["status"]>(async () => ({ state: "queued" })),
  };
  const service = new MessageService(store, transport);
  resources.push({ service, db });
  function session(id: string, over: Partial<Session> = {}): Session {
    const s: Session = {
      id,
      title: `Session ${id}`,
      subtitle: null,
      hostId: "host",
      workspaceId: null,
      projectId: "project",
      cwd: "/repo",
      nativeHandle: { sessionId: `native-${id}`, sessionFile: `/tmp/${id}.jsonl` },
      profileSnapshot: {
        id: "profile",
        name: "Default",
        provider: null,
        model: null,
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
      },
      runtime: "idle",
      runtimeDetail: null,
      connectivity: "connected",
      runId: null,
      taskId: null,
      provenance: "created",
      readOnly: false,
      lastActivityAt: store.nowIso(),
      archivedAt: null,
      queue: { steering: [], followUp: [] },
      stats: null,
      lastAssistantText: null,
      createdAt: store.nowIso(),
      bridge: {
        version: 1,
        runtimeId: `runtime-${id}`,
        nativeSessionId: `native-${id}`,
        agentTools: true,
        messageDelivery: true,
        policyState: "active",
        policyPhases: [],
      },
      ...over,
    };
    store.putSession(s);
    return s;
  }
  session("a");
  session("b");
  function send(from = "a", to = "b", body = "private full body", replyTo?: string) {
    return service.send(from, {
      sessionId: to,
      body,
      mode: "steer",
      ...(replyTo ? { replyTo } : {}),
    });
  }
  function completion(id: string, recipientSessionId = "b", body: unknown = { reply: "snapshot" }) {
    return service.captureCompletion({
      id,
      senderSessionId: "a",
      recipientSessionId,
      body,
      text: "Bounded completion snapshot, formatted by completion capture",
      createdAt: store.nowIso(),
    });
  }
  return {
    db,
    store,
    service,
    transport,
    session,
    send,
    completion,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function flush() {
  // Drain finite chains of worker microtasks, without waiting for the one-second timer.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("durable message capture", () => {
  it("captures full immutable bodies and a safe header without awaiting delivery", () => {
    const h = setup();
    h.session("a", { title: `Hello\n\u0000\u001b\u2028${"😀".repeat(140)}` });
    const m = h.send();
    expect(m).toMatchObject({
      kind: "message",
      body: "private full body",
      replyTo: null,
      chainId: m.id,
      depth: 0,
      deliveryState: "pending",
      readAt: null,
    });
    expect(Date.parse(m.holdUntil) - Date.parse(m.createdAt)).toBe(MESSAGE_HOLD_MS);
    expect(h.transport.accept).not.toHaveBeenCalled();
    expect(messageSenderTitle("a\n\t\u0000b\u2028c")).toBe("ab c");
    expect(Array.from(messageSenderTitle("😀".repeat(121)))).toHaveLength(120);
    expect(ordinaryMessageHeader("x", "safe")).toBe(
      "[Switchyard message x from safe] Call switchyard_inbox to read it.",
    );
  });

  it("rejects self, projectless, cross-project, archived, read-only and nonresumable targets", () => {
    const h = setup();
    expect(() => h.send("a", "a")).toThrow("Use your current session directly");
    expect(() => h.send("a", "missing")).toThrow("not found");
    for (const over of [
      { projectId: null },
      { projectId: "other" },
      { archivedAt: h.store.nowIso() },
      { readOnly: true },
      { runtime: "stopped" as const, nativeHandle: null },
    ]) {
      h.session("b", over);
      expect(() => h.send()).toThrow();
    }
    h.session("b", { runtime: "stopped" });
    expect(h.send().deliveryState).toBe("pending");
    h.session("a", { projectId: null });
    expect(() => h.send()).toThrow("same project");
  });

  it("queries a directed rolling minute limit inside the insertion transaction", () => {
    const h = setup();
    for (let i = 0; i < 10; i++) h.send();
    expect(() => h.send()).toThrow("10 messages");
    expect(h.send("b", "a").id).toBeTruthy();
    h.session("c");
    expect(h.send("a", "c").id).toBeTruthy();
    h.advance(59_999);
    expect(() => h.send()).toThrow("10 messages");
    h.advance(1);
    expect(h.send().id).toBeTruthy();
  });

  it("caps pending ordinary messages at 100 but never loses a completion capture", () => {
    const h = setup();
    for (let sender = 0; sender < 10; sender++) {
      const id = `sender-${sender}`;
      h.session(id);
      for (let i = 0; i < 10; i++) h.send(id);
    }
    expect(() => h.send()).toThrow("100 pending");
    expect(h.completion("completion").kind).toBe("completion");
    const first = h.service.readInbox("b", { limit: 1 }).messages[0]!;
    h.db
      .prepare("UPDATE agent_messages SET delivery_state = 'appended' WHERE id = ?")
      .run(first.id);
    expect(h.send().kind).toBe("message");
  });

  it("joins receipt transactions, rolls capture back, and lets receipt replay bypass quota", () => {
    const h = setup();
    const call = () =>
      h.store.tx(() => {
        const prior = h.db
          .prepare("SELECT result_json FROM agent_call_receipts WHERE tool_call_id = 'tool'")
          .get() as { result_json: string } | undefined;
        if (prior) return JSON.parse(prior.result_json) as AgentMessage;
        const message = h.send();
        h.db
          .prepare(`INSERT INTO agent_call_receipts VALUES ('a', 'native-a', 'tool',
        'message.send', 'hash', ?, ?)`)
          .run(JSON.stringify(message), h.store.nowIso());
        return message;
      });
    expect(() =>
      h.store.tx(() => {
        call();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(h.service.readInbox("b").messages).toHaveLength(0);
    const first = call();
    for (let i = 0; i < 9; i++) h.send();
    expect(() => h.send()).toThrow("10 messages");
    expect(call()).toEqual(first);
    expect(h.service.readInbox("b").messages).toHaveLength(10);
  });

  it("deduplicates immutable completion identities and bypasses pair limits", () => {
    const h = setup();
    for (let i = 0; i < 10; i++) h.send();
    const first = h.completion("notice");
    expect(h.completion("notice")).toEqual(first);
    expect(() => h.completion("notice", "b", { changed: true })).toThrow("identity was reused");
    h.session("b", { runtime: "stopped", archivedAt: h.store.nowIso() });
    expect(h.completion("second").kind).toBe("completion");
  });
});

describe("causal context", () => {
  it("derives explicit reply depth from addressed rows, with a maximum depth of four", () => {
    const h = setup();
    let message = h.send();
    const chainId = message.chainId;
    for (let depth = 1; depth <= 4; depth++) {
      const from = message.recipientSessionId;
      message = h.send(from, message.senderSessionId, "reply", message.id);
      expect(message).toMatchObject({ depth, chainId });
    }
    expect(() => h.send("b", "a", "reply", message.id)).toThrow("Reply limit reached");
    expect(() => h.send("a", "b", "reply", message.id)).toThrow("addressed to this session");
    expect(() => h.send("b", "a", "reply", "missing")).toThrow("addressed to this session");
  });

  it("rejects a depth-four causal reply to a depth-zero ancestor without writes or quota", () => {
    const h = setup();
    const root = h.send();
    let latest = root;
    for (let depth = 1; depth <= 4; depth++) {
      latest = h.send(latest.recipientSessionId, latest.senderSessionId, "reply", latest.id);
    }
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: latest.id });
    const counts = () => ({
      messages: h.db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get(),
      receipts: h.db.prepare("SELECT COUNT(*) AS n FROM agent_call_receipts").get(),
    });
    const before = counts();
    expect(() => h.send("b", "a", "ancestor", root.id)).toThrow("Reply limit reached");
    expect(counts()).toEqual(before);
    h.service.recordContext("b", { humanInputId: "next-human", causalMessageId: null });
    // Two earlier b -> a messages plus eight successful sends exhaust the pair quota.
    for (let i = 0; i < 8; i++) h.send("b", "a");
    expect(() => h.send("b", "a")).toThrow("10 messages");
  });

  it("advances from causal depth when attributing to an older ancestor", () => {
    const h = setup();
    const root = h.send();
    const one = h.send("b", "a", "reply", root.id);
    const two = h.send("a", "b", "reply", one.id);
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: two.id });
    expect(h.send("b", "a", "ancestor", root.id)).toMatchObject({
      replyTo: root.id,
      chainId: root.chainId,
      depth: 3,
    });
    expect(h.send("b", "a")).toMatchObject({ replyTo: two.id, depth: 3 });
  });

  it("advances from a deeper selected same-chain parent without replacing causal context", () => {
    const h = setup();
    const root = h.send();
    const one = h.send("b", "a", "reply", root.id);
    const two = h.send("a", "b", "reply", one.id);
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: root.id });
    expect(h.send("b", "a", "deeper", two.id)).toMatchObject({
      replyTo: two.id,
      chainId: root.chainId,
      depth: 3,
    });
    expect(h.send("b", "a")).toMatchObject({ replyTo: root.id, depth: 1 });
  });

  it("does not regress same-human same-chain trusted context on a stale report", () => {
    const h = setup();
    const root = h.send();
    const one = h.send("b", "a", "reply", root.id);
    const two = h.send("a", "b", "reply", one.id);
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: two.id });
    const restarted = new MessageService(h.store, h.transport);
    restarted.recordContext("b", { humanInputId: "human", causalMessageId: root.id });
    expect(restarted.send("b", { sessionId: "a", body: "reply", mode: "queue" })).toMatchObject({
      replyTo: two.id,
      depth: 3,
    });
    restarted.recordContext("b", { humanInputId: "new-human", causalMessageId: root.id });
    expect(restarted.send("b", { sessionId: "a", body: "reply", mode: "queue" })).toMatchObject({
      replyTo: root.id,
      depth: 1,
    });
  });

  it("persists trusted causal context and does not reset it on reattachment or automated text", () => {
    const h = setup();
    const original = h.send();
    h.service.recordContext("b", { humanInputId: "human-1", causalMessageId: original.id });
    const reattached = new MessageService(h.store, h.transport);
    reattached.recordContext("b", { humanInputId: "human-1", causalMessageId: null });
    const reply = reattached.send("b", { sessionId: "a", body: "automated", mode: "queue" });
    expect(reply).toMatchObject({ replyTo: original.id, depth: 1, chainId: original.id });
    reattached.recordContext("b", { humanInputId: "human-2", causalMessageId: null });
    const root = reattached.send("b", { sessionId: "a", body: "after human", mode: "queue" });
    expect(root).toMatchObject({ replyTo: null, depth: 0, chainId: root.id });
    expect(() =>
      reattached.recordContext("a", {
        humanInputId: null,
        causalMessageId: original.id,
      }),
    ).toThrow("addressed to this session");
    expect(() =>
      reattached.recordContext("b", {
        humanInputId: "human-2",
        causalMessageId: "fake-chain",
      }),
    ).toThrow("addressed to this session");
  });

  it("inherits trusted native context rather than delayed delivery receipts", async () => {
    const h = setup();
    const message = h.send();
    await h.service.deliverPending();
    expect(h.send("b", "a").depth).toBe(0);
    h.service.recordContext("b", { humanInputId: null, causalMessageId: message.id });
    expect(h.send("b", "a")).toMatchObject({ replyTo: message.id, depth: 1 });
    h.service.recordContext("b", { humanInputId: "fresh", causalMessageId: null });
    h.transport.status.mockResolvedValue({ state: "appended" });
    await h.service.reconcileDelivery(message.id); // Append may predate the human reset.
    expect(h.send("b", "a").depth).toBe(0);
    const notice = h.completion("notice");
    expect(h.send("b", "a", "reply", notice.id)).toMatchObject({ replyTo: notice.id, depth: 1 });
  });

  it("enforces inherited depth across reads and ignores caller-supplied depth or chain", () => {
    const h = setup();
    let message = h.send();
    for (let depth = 1; depth <= 4; depth++) {
      message = h.send(message.recipientSessionId, message.senderSessionId, "reply", message.id);
    }
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: message.id });
    h.service.readInbox("b");
    const input = {
      sessionId: "a",
      body: "reply",
      mode: "queue" as const,
      depth: 0,
      chainId: "fake",
    };
    expect(() => h.service.send("b", input)).toThrow("Reply limit reached");
    h.service.recordContext("b", { humanInputId: "next-human", causalMessageId: null });
    const root = h.service.send("b", input);
    expect(root).toMatchObject({ depth: 0, chainId: root.id });
  });

  it("rejects substitution of another chain until a real human reset", () => {
    const h = setup();
    const original = h.send();
    const other = h.send();
    h.service.recordContext("b", { humanInputId: "human", causalMessageId: original.id });
    expect(() => h.send("b", "a", "reply", other.id)).toThrow("another causal message chain");
    h.service.recordContext("b", { humanInputId: "new-human", causalMessageId: null });
    expect(h.send("b", "a", "reply", other.id).chainId).toBe(other.chainId);
  });
});

describe("inbox reads", () => {
  it("isolates the caller, paginates by seq, and marks only returned rows read", () => {
    const h = setup();
    const first = h.send();
    h.send("b", "a");
    const second = h.send();
    const inspect = h.service.readInbox("b", { limit: 1 }, { markRead: false });
    expect(inspect).toMatchObject({ nextAfter: first.seq, hasMore: true });
    expect(inspect.messages[0]?.readAt).toBeNull();
    const page = h.service.readInbox("b", { limit: 1 });
    expect(page.messages[0]?.readAt).toBe(h.store.nowIso());
    expect(h.service.get(second.id)?.readAt).toBeNull();
    h.advance(1000);
    expect(h.service.readInbox("b", { limit: 1 }).messages[0]?.readAt).toBe(
      page.messages[0]?.readAt,
    );
    const next = h.service.readInbox("b", { after: page.nextAfter });
    expect(next).toMatchObject({ nextAfter: second.seq, hasMore: false });
    expect(next.messages.map((m) => m.id)).toEqual([second.id]);
    expect(h.service.readInbox("b", { after: next.nextAfter })).toEqual({
      messages: [],
      nextAfter: second.seq,
      hasMore: false,
    });
    expect(() => h.service.readInbox("b", { after: -1 })).toThrow();
    expect(() => h.service.readInbox("b", { limit: 101 })).toThrow();
  });

  it("bounds UTF-8 serialized page bytes and advances only over returned records", () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.send("a", "b", "界".repeat(16_000));
    const page = h.service.readInbox("b", { limit: 100 });
    expect(page.messages).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(INBOX_PAGE_BYTES);
    expect(page.hasMore).toBe(true);
    expect(h.service.readInbox("b", { after: page.nextAfter }).messages).toHaveLength(2);
    const all = h.service.readInbox("b", { limit: 100 }, { markRead: false });
    expect(h.service.get(all.messages[1]!.id)?.readAt).not.toBeNull();
    const unread = h.db
      .prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE read_at IS NULL")
      .get();
    expect(unread?.n).toBe(1);
  });

  it("accounts for the final hasMore:false byte and preserves an oversized captured item", () => {
    const baseline = setup();
    baseline.completion("sized", "b", "");
    const emptySize = Buffer.byteLength(
      JSON.stringify(baseline.service.readInbox("b", {}, { markRead: false })),
    );
    const h = setup();
    const body = "x".repeat(INBOX_PAGE_BYTES - emptySize + 1);
    const captured = h.completion("sized", "b", body);
    expect(() => h.service.readInbox("b", {}, { markRead: false })).toThrow(
      "serialized page limit",
    );
    expect(h.service.get(captured.id)).toMatchObject({ body, readAt: null });
  });

  it("rolls read markers back with a failed receipt write; stored results stay replayable", () => {
    const h = setup();
    const m = h.send();
    expect(() =>
      h.store.tx(() => {
        h.service.readInbox("b");
        throw new Error("receipt failed");
      }),
    ).toThrow("receipt failed");
    expect(h.service.get(m.id)?.readAt).toBeNull();
    const page = h.store.tx(() => {
      const result = h.service.readInbox("b");
      h.db
        .prepare(`INSERT INTO agent_call_receipts VALUES ('b', 'native-b', 'read-tool',
        'inbox.read', 'hash', ?, ?)`)
        .run(JSON.stringify(result), h.store.nowIso());
      return result;
    });
    h.send();
    const stored = h.db.prepare("SELECT result_json FROM agent_call_receipts").get() as {
      result_json: string;
    };
    expect(JSON.parse(stored.result_json)).toEqual(page);
    expect(h.service.get(m.id)?.deliveryState).toBe("pending");
  });

  it("retains messages, headers and causal state outside event retention and service restarts", async () => {
    const h = setup();
    const m = h.send();
    h.service.recordContext("b", { humanInputId: null, causalMessageId: m.id });
    h.advance(100 * 86_400_000);
    h.store.runRetention();
    const restarted = new MessageService(h.store, h.transport);
    expect(restarted.readInbox("b").messages[0]?.body).toBe(m.body);
    expect(restarted.send("b", { sessionId: "a", body: "reply", mode: "queue" }).replyTo).toBe(
      m.id,
    );
    await restarted.deliverPending();
    expect(h.transport.accept).toHaveBeenCalled();
  });
});

describe("delivery worker", () => {
  it("uses immutable header-only payloads, deterministic acceptance and fresh status reads", async () => {
    const h = setup();
    const message = h.send();
    h.session("a", { title: "Changed after capture" });
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledWith(
      "host",
      {
        sessionId: "b",
        messageId: message.id,
        payload: {
          deliveryId: message.id,
          kind: "message",
          text: ordinaryMessageHeader(message.id, "Session a"),
        },
        mode: "steer",
        holdUntil: message.holdUntil,
      },
      { commandId: `msg_${message.id}` },
    );
    expect(h.service.get(message.id)?.deliveryState).toBe("accepted");
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
    expect(h.transport.status).toHaveBeenCalledWith("host", "b", message.id);
    expect(h.service.get(message.id)?.deliveryState).toBe("queued");
    h.transport.status.mockResolvedValue({ state: "appended" });
    await h.service.deliverPending();
    expect(h.service.get(message.id)?.deliveryState).toBe("appended");
    await h.service.deliverPending();
    expect(h.transport.status).toHaveBeenCalledTimes(2);
    expect(h.service.readInbox("b").messages[0]?.body).toBe(message.body);
  });

  it("retries lost host acceptance with exactly the same logical command and original deadline", async () => {
    const h = setup();
    const m = h.send();
    h.transport.accept.mockRejectedValueOnce(new Error("receipt lost"));
    await h.service.deliverPending();
    expect(h.service.get(m.id)?.deliveryState).toBe("deferred");
    h.advance(MESSAGE_HOLD_MS + 1);
    await h.service.deliverPending();
    expect(h.transport.accept.mock.calls[0]).toEqual(h.transport.accept.mock.calls[1]);
    expect(h.service.get(m.id)?.holdUntil).toBe(m.holdUntil);
  });

  it("never enqueues again for held/queued jobs or unresolved ambiguity", async () => {
    const h = setup();
    const m = h.send();
    h.transport.accept.mockResolvedValue({ state: "held" });
    await h.service.deliverPending();
    h.advance(MESSAGE_HOLD_MS + 1);
    h.transport.status.mockResolvedValue(null);
    await h.service.deliverPending();
    expect(h.service.get(m.id)?.deliveryState).toBe("uncertain");
    h.transport.status.mockResolvedValue({ state: "held" });
    await h.service.deliverPending();
    expect(h.service.get(m.id)?.deliveryState).toBe("uncertain");
    h.transport.status.mockResolvedValue({ state: "queued" });
    await h.service.deliverPending();
    expect(h.service.get(m.id)?.deliveryState).toBe("queued");
    h.transport.status.mockResolvedValue({ state: "appended" });
    await h.service.deliverPending();
    expect(h.service.get(m.id)?.deliveryState).toBe("appended");
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
  });

  it("keeps accepted state across failed status reads and coordinator worker restart", async () => {
    const h = setup();
    const m = h.send();
    await h.service.deliverPending();
    h.transport.status.mockRejectedValueOnce(new Error("offline"));
    await h.service.reconcileDelivery(m.id);
    expect(h.service.get(m.id)?.deliveryState).toBe("accepted");
    const restarted = new MessageService(h.store, h.transport);
    await restarted.deliverPending();
    expect(restarted.get(m.id)?.deliveryState).toBe("queued");
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
  });

  it("does not revive offline, archived, stopped, read-only or unsupported sessions at expiry", async () => {
    const h = setup();
    const m = h.send();
    h.advance(MESSAGE_HOLD_MS + 1);
    for (const over of [
      { runtime: "stopped" as const },
      { archivedAt: h.store.nowIso() },
      { readOnly: true },
      { bridge: undefined },
    ]) {
      h.session("b", over);
      await h.service.deliverPending();
      expect(h.service.get(m.id)?.deliveryState).toBe("deferred");
    }
    h.session("b");
    h.transport.isConnected.mockReturnValue(false);
    await h.service.deliverPending();
    expect(h.transport.accept).not.toHaveBeenCalled();
    h.transport.isConnected.mockReturnValue(true);
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
  });

  it("limits a tick to 20 items, rotating past held recipients without starvation", async () => {
    const h = setup();
    for (let i = 0; i < 25; i++) h.completion(`completion-${i}`);
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(20);
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(25);
    await h.service.deliverPending();
    expect(h.transport.status).toHaveBeenCalledTimes(20);
  });

  it("allows only one in-flight operation per target and never awaits inside a transaction", async () => {
    const h = setup();
    h.send();
    h.send();
    let finish!: (value: { state: DeliveryState }) => void;
    h.transport.accept.mockImplementation(() => {
      expect(h.store.inTransaction).toBe(false);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const attempt = h.service.deliverPending();
    await flush();
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = h.service.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    finish({ state: "accepted" });
    await Promise.all([attempt, stop]);
    expect(stopped).toBe(true);
    await h.service.deliverPending();
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
  });

  it("wakes on insertion, reconnect, resume, and the one-second tick, and stops cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = setup();
    h.service.start();
    h.service.start();
    await flush();
    const m = h.send();
    await flush();
    expect(h.service.get(m.id)?.deliveryState).toBe("accepted");
    h.store.hub.emit("host.connected", { hostId: "host", reconnect: true });
    await flush();
    expect(h.service.get(m.id)?.deliveryState).toBe("queued");
    h.transport.status.mockResolvedValue({ state: "held" });
    h.session("b");
    await flush();
    expect(h.service.get(m.id)?.deliveryState).toBe("held");
    h.transport.status.mockResolvedValue({ state: "appended" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.service.get(m.id)?.deliveryState).toBe("appended");
    await h.service.stop();
    const count = h.transport.status.mock.calls.length;
    h.store.hub.emit("host.connected", { hostId: "host", reconnect: true });
    h.send();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.transport.status).toHaveBeenCalledTimes(count);
    expect(h.transport.accept).toHaveBeenCalledTimes(1);
  });
});
