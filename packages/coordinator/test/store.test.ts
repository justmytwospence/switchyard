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
