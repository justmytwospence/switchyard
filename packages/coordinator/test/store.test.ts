import { join } from "node:path";
import { DEFAULT_TASK_POLICY, type EventEnvelope, type Task } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub, migrate, openDb, Store } from "../src/index.js";
import { tempDir } from "./helpers.js";

let db: ReturnType<typeof openDb> | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function makeStore(): Store {
  db = openDb(join(tempDir("sy-store-"), "db.sqlite"));
  migrate(db);
  return new Store(db, new EventHub());
}

describe("policy root epochs", () => {
  const task = (id: string, parentTaskId: string | null = null): Task => ({
    id,
    projectId: "project",
    title: id,
    objective: "",
    acceptanceCriteria: [],
    dependencies: [],
    priority: 0,
    position: 0,
    state: "backlog",
    blocked: null,
    notBefore: null,
    policy: DEFAULT_TASK_POLICY,
    origin: { kind: "manual" },
    groupingKey: null,
    parentTaskId,
    currentRunId: null,
    sessionId: null,
    review: { feedback: [], changesRequested: false },
    hiddenFromBoard: false,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const epoch = (store: Store, id: string) => store.getSetting(`policyRootEpoch:${id}`, 0);

  it("fences terminal transitions and root deletion, not edits or child transitions", () => {
    const store = makeStore();
    const root = task("root");
    const child = task("child", root.id);
    store.putTask(root);
    store.putTask(child);
    store.putTask({ ...child, state: "done" });
    expect(epoch(store, child.id)).toBe(0);
    store.putTask({ ...root, state: "done" });
    expect(epoch(store, root.id)).toBe(1);
    store.putTask({ ...root, state: "done", title: "edited" });
    store.putTask({ ...root, state: "canceled" });
    expect(epoch(store, root.id)).toBe(1);
    store.putTask(root);
    expect(epoch(store, root.id)).toBe(2);
    store.putTask({ ...root, state: "canceled" });
    expect(epoch(store, root.id)).toBe(3);
    store.deleteTask(root);
    expect(epoch(store, root.id)).toBe(4);
    expect(store.tasks.require(child.id).parentTaskId).toBeNull();
    store.deleteTask(root);
    expect(epoch(store, root.id)).toBe(4);
  });

  it("fences terminal root creation and terminal reparenting before publishing", () => {
    const store = makeStore();
    const root = { ...task("root"), state: "done" as const };
    const seen: number[] = [];
    store.hub.on("event", (event: EventEnvelope) => {
      if (event.taskId === root.id) seen.push(epoch(store, root.id));
    });
    store.putTask(root);
    store.putTask({ ...root, parentTaskId: "parent" });
    store.putTask(root);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("rolls back epochs with task transitions and deletions", () => {
    const store = makeStore();
    const root = task("root");
    store.putTask(root);
    expect(() =>
      store.tx(() => {
        store.putTask({ ...root, state: "done" });
        expect(epoch(store, root.id)).toBe(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(epoch(store, root.id)).toBe(0);
    expect(store.tasks.require(root.id).state).toBe("backlog");
    expect(() =>
      store.tx(() => {
        store.deleteTask(root);
        expect(epoch(store, root.id)).toBe(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(epoch(store, root.id)).toBe(0);
    expect(store.tasks.get(root.id)).toBeDefined();
  });

  it("fails closed when the epoch cannot be incremented safely", () => {
    const store = makeStore();
    const root = task("root");
    store.putTask(root);
    store.setSetting(`policyRootEpoch:${root.id}`, Number.MAX_SAFE_INTEGER);
    expect(() => store.putTask({ ...root, state: "done" })).toThrow(/epoch/);
    expect(() => store.deleteTask(root)).toThrow(/epoch/);
    expect(store.tasks.require(root.id).state).toBe("backlog");
  });
});

describe("item revisions", () => {
  const item = (id: string, order: number, text = "x") =>
    ({
      id,
      sessionId: "ses_r",
      order,
      at: "2026-01-01T00:00:00.000Z",
      kind: "user",
      data: { text },
    }) as never;

  it("grow on every upsert and continue across replaceItems", () => {
    const store = makeStore();
    store.upsertItem(item("a", 0));
    store.upsertItem(item("b", 1));
    expect(store.maxItemRev("ses_r")).toBe(2);
    store.upsertItem(item("a", 0, "changed"));
    expect(store.maxItemRev("ses_r")).toBe(3);
    expect(store.listItemsAfterRev("ses_r", 2).items.map((i) => i.id)).toEqual(["a"]);
    store.replaceItems("ses_r", [item("c", 0), item("d", 1)]);
    expect(store.maxItemRev("ses_r")).toBe(5);
    expect(store.listItemsAfterRev("ses_r", 3).items.map((i) => i.id)).toEqual(["c", "d"]);
    expect(store.listItemsAfterRev("ses_r", 0, 1).more).toBe(true);
  });
});

describe("store publication order", () => {
  it("a listener that writes during publication cannot reorder the batch", () => {
    const store = makeStore();
    const seqs: number[] = [];
    let first = true;
    store.hub.on("event", (e: EventEnvelope) => {
      seqs.push(e.seq);
      if (first) {
        first = false;
        store.tx(() => store.appendEvent("settings.updated", {}, { dispatchPaused: true }));
      }
    });
    store.tx(() => {
      store.appendEvent("project.deleted", {}, { id: "a" });
      store.appendEvent("project.deleted", {}, { id: "b" });
    });
    expect(seqs).toHaveLength(3);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
  });

  it("afterCommit callbacks run after their batch and before a nested batch", () => {
    const store = makeStore();
    const log: string[] = [];
    let first = true;
    store.hub.on("event", (e: EventEnvelope) => {
      log.push(`E${e.seq}`);
      if (first) {
        first = false;
        store.tx(() => store.appendEvent("settings.updated", {}, { dispatchPaused: true }));
      }
    });
    store.tx(() => {
      store.appendEvent("project.deleted", {}, { id: "a" });
      store.afterCommit(() => log.push("F"));
    });
    expect(log).toEqual(["E1", "F", "E2"]);
  });

  it("publishing resumes after a listener throws", () => {
    const store = makeStore();
    const seen: number[] = [];
    store.hub.on("event", () => {
      throw new Error("boom");
    });
    store.hub.on("event", (e: EventEnvelope) => seen.push(e.seq));
    store.tx(() => store.appendEvent("project.deleted", {}, { id: "a" }));
    store.tx(() => store.appendEvent("project.deleted", {}, { id: "b" }));
    expect(seen).toHaveLength(2);
    expect(store.inTransaction).toBe(false);
  });
});
