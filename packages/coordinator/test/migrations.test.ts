import { describe, expect, it } from "vitest";
import { type Db, MIGRATIONS, migrate, openDb } from "../src/db/index.js";

/** A database migrated to `version`, as an older coordinator would have left it. */
function dbAt(version: number): Db {
  const db = openDb(":memory:");
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      m.version,
      m.name,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

describe("coordinator migrations", () => {
  it("009 backfills indexed parents without rewriting legacy task JSON", () => {
    const db = dbAt(8);
    const insert = db.prepare(
      "INSERT INTO tasks (id, project_id, state, json, created_at, updated_at) VALUES (?, 'p', 'backlog', ?, '2026-01-01', '2026-01-01')",
    );
    const legacy = '{"id":"root"}';
    insert.run("root", legacy);
    insert.run("null", '{"id":"null","parentTaskId":null}');
    insert.run("child", '{"id":"child","parentTaskId":"root"}');
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT parent_task_id, json FROM tasks WHERE id = 'root'").get()).toEqual({
      parent_task_id: null,
      json: legacy,
    });
    expect(db.prepare("SELECT parent_task_id FROM tasks WHERE id = 'null'").get()).toEqual({
      parent_task_id: null,
    });
    expect(db.prepare("SELECT id FROM tasks WHERE parent_task_id = 'root'").all()).toEqual([
      { id: "child" },
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: "tasks_parent" },
        { name: "agent_messages_pair_time" },
        { name: "agent_messages_recipient_seq" },
      ]),
    );
    db.close();
  });

  it("009 keys receipts by caller/native/tool/method and subscriptions by child/subscriber", () => {
    const db = dbAt(8);
    migrate(db);
    const receipt = db.prepare(
      "INSERT INTO agent_call_receipts VALUES (?, ?, ?, ?, 'hash', '{}', '2026-01-01')",
    );
    receipt.run("caller", "native", "tool", "task.create");
    expect(() => receipt.run("caller", "native", "tool", "task.create")).toThrow(/UNIQUE/);
    receipt.run("other", "native", "tool", "task.create");
    receipt.run("caller", "other", "tool", "task.create");
    receipt.run("caller", "native", "tool", "message.send");
    const subscription = db.prepare(
      "INSERT INTO task_subscriptions VALUES (?, ?, ?, '2026-01-01')",
    );
    subscription.run("child", "creator", null);
    expect(() => subscription.run("child", "creator", "parent")).toThrow(/UNIQUE/);
    subscription.run("child", "other", "parent");
    db.close();
  });

  it("009 assigns immutable increasing inbox cursors independently of retention", () => {
    const db = dbAt(8);
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO agent_messages (id, kind, sender_session_id, recipient_session_id, chain_id, depth, body_json, requested_mode, delivery_state, hold_until, created_at, updated_at) VALUES (?, 'message', 'sender', 'recipient', 'chain', 0, '{}', 'queue', 'pending', '2026-01-01', '2026-01-01', '2026-01-01')",
    );
    expect(Number(insert.run("first").lastInsertRowid)).toBe(1);
    expect(() => insert.run("first")).toThrow(/UNIQUE/);
    db.exec("DELETE FROM agent_messages");
    expect(Number(insert.run("second").lastInsertRowid)).toBe(2);
    db.close();
  });

  it("008 adds the item revision column", () => {
    const db = dbAt(7);
    db.prepare(
      "INSERT INTO session_items (session_id, item_id, ord, json) VALUES ('s','i',0,'{}')",
    ).run();
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT rev FROM session_items").get()).toEqual({ rev: 0 });
  });

  it("004 rewrites cancelled interactions and their update events", () => {
    const db = dbAt(3);
    db.prepare(
      "INSERT INTO interactions (id, session_id, state, revision, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("int_1", "ses_1", "cancelled", 2, '{"id":"int_1","state":"cancelled"}', "2026-01-01");
    db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)").run(
      "evt_1",
      "interaction.updated",
      '{"id":"int_1","state":"cancelled"}',
      "2026-01-01",
    );
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const row = db.prepare("SELECT state, json FROM interactions WHERE id = 'int_1'").get() as {
      state: string;
      json: string;
    };
    expect(row.state).toBe("canceled");
    expect(JSON.parse(row.json).state).toBe("canceled");
    const ev = db.prepare("SELECT json FROM events WHERE id = 'evt_1'").get() as { json: string };
    expect(JSON.parse(ev.json).state).toBe("canceled");
  });

  it("005 renames the workspace.removed event", () => {
    const db = dbAt(4);
    db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)").run(
      "evt_2",
      "workspace.removed",
      '{"id":"wsp_1"}',
      "2026-01-01",
    );
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const ev = db.prepare("SELECT type FROM events WHERE id = 'evt_2'").get() as { type: string };
    expect(ev.type).toBe("workspace.deleted");
  });

  it("006 archives duplicate native files and makes them unique", () => {
    const db = dbAt(5);
    const insert = (
      id: string,
      file: string | null,
      createdAt: string,
      runtime = "stopped",
      host = "hst_1",
    ) =>
      db
        .prepare(
          "INSERT INTO sessions (id, host_id, runtime, native_session_file, archived_at, last_activity_at, json) VALUES (?, ?, ?, ?, NULL, ?, ?)",
        )
        .run(
          id,
          host,
          runtime,
          file,
          createdAt,
          JSON.stringify({
            id,
            createdAt,
            runtime,
            archivedAt: null,
            nativeHandle: file ? { sessionId: id, sessionFile: file } : null,
          }),
        );
    insert("ses_old", "/s/a.jsonl", "2026-01-01");
    insert("ses_new", "/s/a.jsonl", "2026-01-02");
    insert("ses_b_old", "/s/b.jsonl", "2026-01-01");
    insert("ses_live_new", "/s/b.jsonl", "2026-01-02", "idle");
    insert("ses_n1", null, "2026-01-01");
    insert("ses_n2", null, "2026-01-02");
    insert("ses_other_host", "/s/a.jsonl", "2026-01-03", "stopped", "hst_2");
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const row = (id: string) =>
      db
        .prepare("SELECT archived_at, native_session_file, json FROM sessions WHERE id = ?")
        .get(id) as {
        archived_at: string | null;
        native_session_file: string | null;
        json: string;
      };
    expect(row("ses_old")).toMatchObject({ archived_at: null, native_session_file: "/s/a.jsonl" });
    const dup = row("ses_new");
    expect(dup.archived_at).not.toBeNull();
    expect(dup.native_session_file).toBeNull();
    expect(JSON.parse(dup.json)).toMatchObject({ nativeHandle: null, archivedAt: dup.archived_at });
    expect(row("ses_live_new")).toMatchObject({
      archived_at: null,
      native_session_file: "/s/b.jsonl",
    });
    expect(row("ses_b_old").archived_at).not.toBeNull();
    expect(row("ses_other_host")).toMatchObject({
      archived_at: null,
      native_session_file: "/s/a.jsonl",
    });
    expect(row("ses_n1")).toMatchObject({ archived_at: null, native_session_file: null });
    expect(row("ses_n2")).toMatchObject({ archived_at: null, native_session_file: null });
    expect(() => insert("ses_dup", "/s/a.jsonl", "2026-02-01")).toThrow(/UNIQUE/);
  });
});
