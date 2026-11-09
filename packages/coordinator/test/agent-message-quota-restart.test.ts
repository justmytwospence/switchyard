import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/agents/messages.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";

const resources: { db: ReturnType<typeof openDb>; messages: MessageService }[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const { db, messages } of resources.splice(0)) {
    await messages.stop();
    db.close();
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openCoordinatorDb(path: string, clock: () => Date) {
  const db = openDb(path);
  migrate(db);
  const store = new Store(db, new EventHub(), clock);
  const transport = {
    isConnected: vi.fn(() => false),
    accept: vi.fn(async () => ({ state: "accepted" as const })),
    status: vi.fn(async () => null),
  };
  const messages = new MessageService(store, transport);
  resources.push({ db, messages });
  return { db, store, messages };
}

function session(id: string, at: string): Session {
  return {
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
    lastActivityAt: at,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: at,
  };
}

describe("directed message quota after a coordinator database restart", () => {
  it("retains the pair's rolling minute usage and expires only the rows at the boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sy-message-quota-"));
    directories.push(dir);
    const path = join(dir, "coordinator.sqlite");
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    let now = start;
    const clock = () => new Date(now);
    const initial = openCoordinatorDb(path, clock);
    for (const id of ["a", "b", "c"]) initial.store.putSession(session(id, clock().toISOString()));
    const send = (messages: MessageService, from = "a", to = "b") =>
      messages.send(from, { sessionId: to, body: "durable message", mode: "queue" });
    const captured = Array.from({ length: 5 }, () => send(initial.messages));
    now += 30_000;
    captured.push(...Array.from({ length: 5 }, () => send(initial.messages)));
    expect(() => send(initial.messages)).toThrow("10 messages per recipient per rolling minute");

    // Actually close the SQLite handle; a new service over the same open handle is not a restart.
    await initial.messages.stop();
    initial.db.close();
    resources.pop();
    const reopened = openCoordinatorDb(path, clock);
    expect(
      reopened.store.sessions
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(reopened.messages.readInbox("b", {}, { markRead: false }).messages).toEqual(captured);
    const rejectWithoutCapture = () => {
      const before = reopened.db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get();
      expect(() => send(reopened.messages)).toThrow("10 messages per recipient per rolling minute");
      expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get()).toEqual(before);
    };
    rejectWithoutCapture();
    // Neither the reversed direction nor a different recipient shares a -> b's quota.
    expect(send(reopened.messages, "b", "a").senderSessionId).toBe("b");
    expect(send(reopened.messages, "a", "c").recipientSessionId).toBe("c");
    rejectWithoutCapture();

    now = start + 59_999;
    rejectWithoutCapture();
    now += 1;
    // At exactly one minute, only the first five rows leave the rolling window.
    for (let i = 0; i < 5; i++) expect(send(reopened.messages).kind).toBe("message");
    rejectWithoutCapture();
    now = start + 89_999;
    rejectWithoutCapture();
    now += 1;
    for (let i = 0; i < 5; i++) expect(send(reopened.messages).kind).toBe("message");
    rejectWithoutCapture();
    // Expiring rate usage must not prune the durable inbox bodies.
    expect(
      reopened.messages.readInbox("b", { limit: 100 }, { markRead: false }).messages,
    ).toHaveLength(20);
  });
});
