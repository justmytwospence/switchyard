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
  {
    name: "002_interaction_canceled",
    sql: "UPDATE interactions SET state = 'canceled', json = json_set(json, '$.state', 'canceled') WHERE state = 'cancelled';",
  },
  {
    name: "003_agent_messages",
    sql: `
-- Logical delivery receipts outlive generic command receipts. An applying claim means Pi may
-- have received the message; only native append evidence or a live queue can reconcile it.
CREATE TABLE message_receipts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  requested_mode TEXT NOT NULL CHECK (requested_mode IN ('steer', 'queue')),
  hold_until TEXT NOT NULL,
  offer_hash TEXT NOT NULL CHECK (length(offer_hash) = 64 AND offer_hash NOT GLOB '*[^0-9a-f]*'),
  attempt_id TEXT,
  attempt_runtime_id TEXT,
  attempt_native_session_id TEXT,
  -- Latch confirmed invocation evidence: a later missing queue must never authorize reaccept.
  effect_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (effect_confirmed IN (0, 1)),
  next_attempt_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'accepted', 'applying', 'held', 'deferred', 'queued', 'appended', 'uncertain', 'failed'
  )),
  claimed_at TEXT,
  result_json TEXT,
  reason TEXT CHECK (reason IN ('draft', 'dialog', 'effect_unknown')),
  updated_at TEXT NOT NULL,
  CHECK (
    (attempt_id IS NULL AND attempt_runtime_id IS NULL AND attempt_native_session_id IS NULL)
    OR (attempt_id IS NOT NULL AND attempt_runtime_id IS NOT NULL AND attempt_native_session_id IS NOT NULL)
  ),
  CHECK (state NOT IN ('applying', 'held', 'queued', 'appended', 'uncertain') OR attempt_id IS NOT NULL),
  PRIMARY KEY (session_id, message_id)
);
CREATE INDEX message_receipts_due ON message_receipts (next_attempt_at)
  WHERE state NOT IN ('appended', 'failed');
`,
  },
];
