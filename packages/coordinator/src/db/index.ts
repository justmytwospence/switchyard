import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sql as init } from "./migrations/001_init.js";
import { sql as ownerAuth } from "./migrations/002_owner_auth.js";
import { sql as terminalLogin } from "./migrations/003_terminal_login.js";
import { sql as interactionCanceled } from "./migrations/004_interaction_canceled.js";
import { sql as workspaceDeletedEvent } from "./migrations/005_workspace_deleted_event.js";
import { sql as uniqueNativeSession } from "./migrations/006_unique_native_session.js";
import { sql as views } from "./migrations/007_views.js";
import { sql as itemRev } from "./migrations/008_item_rev.js";
import { sql as agentTools } from "./migrations/009_agent_tools.js";
import { sql as taskNotifications } from "./migrations/010_task_notifications.js";
import { sql as policies } from "./migrations/011_policies.js";
import { sql as policyWaitLeases } from "./migrations/012_policy_wait_leases.js";
import { sql as githubMergeFences } from "./migrations/013_github_merge_fences.js";

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
  { version: 6, name: "006_unique_native_session", sql: uniqueNativeSession },
  { version: 7, name: "007_views", sql: views },
  { version: 8, name: "008_item_rev", sql: itemRev },
  { version: 9, name: "009_agent_tools", sql: agentTools },
  { version: 10, name: "010_task_notifications", sql: taskNotifications },
  { version: 11, name: "011_policies", sql: policies },
  { version: 12, name: "012_policy_wait_leases", sql: policyWaitLeases },
  { version: 13, name: "013_github_merge_fences", sql: githubMergeFences },
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
