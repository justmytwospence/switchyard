/**
 * Host database migrations, applied in order and recorded in `schema_migrations`.
 * Kept as TypeScript strings (not `.sql` files) so `tsc` ships them in `dist/` unchanged.
 */
export interface Migration {
  /** `NNN_name`, sorted lexicographically. */
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "001_init",
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Durable host events, persisted before they are sent. host_seq is never reused.
CREATE TABLE outbox (
  host_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Stored command receipts, resent for a duplicate commandId.
CREATE TABLE receipts (
  command_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dispatches (
  dispatch_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'workspace_ready', 'started', 'failed')),
  workspace_path TEXT,
  error TEXT,
  result_json TEXT,
  updated_at TEXT NOT NULL
);

-- Host-side session records: native handle, workspace path, profile, control revision and mode,
-- transcript order counter.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX interactions_by_session ON interactions (session_id, state);

CREATE TABLE adapter_state (
  session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, adapter_id, key)
);

CREATE TABLE panels (
  session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, adapter_id, slot)
);
`,
  },
];
