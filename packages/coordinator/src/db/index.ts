import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sql as init } from "./migrations/001_init.js";
import { sql as ownerAuth } from "./migrations/002_owner_auth.js";
import { sql as terminalLogin } from "./migrations/003_terminal_login.js";
import { sql as interactionCanceled } from "./migrations/004_interaction_canceled.js";
import { sql as workspaceDeletedEvent } from "./migrations/005_workspace_deleted_event.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered migrations. Append only; never edit an applied one. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "001_init", sql: init },
  { version: 2, name: "002_owner_auth", sql: ownerAuth },
  { version: 3, name: "003_terminal_login", sql: terminalLogin },
  { version: 4, name: "004_interaction_canceled", sql: interactionCanceled },
  { version: 5, name: "005_workspace_deleted_event", sql: workspaceDeletedEvent },
];
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export type Db = DatabaseSync;
export type SqlValue = SQLInputValue;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** Applied migration level (0 when the table does not exist). */
export function migrationLevel(db: Db): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/** Apply pending migrations in order, each in its own transaction. Returns the new level. */
export function migrate(db: Db): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const level = migrationLevel(db);
  if (level > LATEST_MIGRATION) {
    throw new Error(
      `Database schema version ${level} is newer than this coordinator supports (${LATEST_MIGRATION})`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= level) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return migrationLevel(db);
}
