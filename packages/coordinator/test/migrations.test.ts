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
});
