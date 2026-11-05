import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HostDb, openHostDb, pruneHostDb } from "../src/db/index.js";
import { tempDir } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

describe("pruneHostDb", () => {
  let db: HostDb;
  let cleanup: () => void = () => {};
  afterEach(() => {
    db?.close();
    cleanup();
  });

  it("prunes ended sessions' interactions and panels and old dispatches; keeps records and adapter state", () => {
    const dir = tempDir();
    cleanup = dir.cleanup;
    db = openHostDb(join(dir.path, "host.db"));
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const session = (id: string, json: object) =>
      db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [
        id,
        JSON.stringify({ id, ...json }),
      ]);
    session("A", { runtime: "stopped", endedAt: ago(40), lastActivityAt: ago(40) });
    session("B", { runtime: "stopped", endedAt: ago(5), lastActivityAt: ago(40) });
    session("C", { runtime: "idle", lastActivityAt: ago(40) });
    session("D", { runtime: "failed", lastActivityAt: ago(40) });
    for (const id of ["A", "B", "C", "D"]) {
      db.run(
        "INSERT INTO interactions (id, session_id, revision, state, json) VALUES (?, ?, 1, 'resolved', '{}')",
        [`int_${id}`, id],
      );
      db.run(
        "INSERT INTO panels (session_id, adapter_id, slot, json) VALUES (?, 'ad', 'main', '{}')",
        [id],
      );
      db.run(
        "INSERT INTO adapter_state (session_id, adapter_id, key, json) VALUES (?, 'ad', 'k', '{}')",
        [id],
      );
    }
    db.run(
      "INSERT INTO interactions (id, session_id, revision, state, json) VALUES ('int_A_pending', 'A', 1, 'pending', '{}')",
    );
    const dispatch = (key: string, state: string, updatedAt: string) =>
      db.run(
        "INSERT INTO dispatches (dispatch_key, run_id, state, updated_at) VALUES (?, 'run', ?, ?)",
        [key, state, updatedAt],
      );
    dispatch("old_started", "started", ago(40));
    dispatch("old_failed", "failed", ago(40));
    dispatch("old_accepted", "accepted", ago(40));
    dispatch("new_started", "started", ago(1));

    expect(pruneHostDb(db, now)).toEqual({ interactions: 2, panels: 2, dispatches: 2 });

    const ids = (sql: string) => db.all<{ id: string }>(sql).map((r) => r.id);
    expect(ids("SELECT id FROM interactions ORDER BY id")).toEqual([
      "int_A_pending",
      "int_B",
      "int_C",
    ]);
    expect(ids("SELECT session_id AS id FROM panels ORDER BY session_id")).toEqual(["B", "C"]);
    expect(ids("SELECT session_id AS id FROM adapter_state ORDER BY session_id")).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(ids("SELECT id FROM sessions ORDER BY id")).toEqual(["A", "B", "C", "D"]);
    expect(ids("SELECT dispatch_key AS id FROM dispatches ORDER BY dispatch_key")).toEqual([
      "new_started",
      "old_accepted",
    ]);
  });
});
