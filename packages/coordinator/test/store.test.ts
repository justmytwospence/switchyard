import { join } from "node:path";
import type { EventEnvelope } from "@switchyard/protocol";
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
