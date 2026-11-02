/**
 * 001_init: every coordinator table.
 *
 * Kept as a TypeScript string (not a loose .sql file) so `tsc -b` ships it in `dist` with no
 * copy step. Entities are stored as JSON TEXT with indexed scalar columns for lookups.
 */
export const sql = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser','pwa','terminal','cli')),
  credential_hash TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  last_seen_at TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  acked_host_seq INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('device','host')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  result_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  repo_identity TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_repo_identity ON projects(repo_identity);

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  path TEXT NOT NULL,
  json TEXT NOT NULL,
  UNIQUE (host_id, path)
);
CREATE INDEX checkouts_project ON checkouts(project_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  path TEXT NOT NULL,
  archived_at TEXT,
  json TEXT NOT NULL,
  UNIQUE (host_id, path)
);
CREATE INDEX workspaces_project ON workspaces(project_id);
CREATE INDEX workspaces_checkout ON workspaces(checkout_id);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  task_id TEXT,
  run_id TEXT,
  runtime TEXT NOT NULL,
  native_session_file TEXT,
  archived_at TEXT,
  last_activity_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX sessions_host ON sessions(host_id);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_workspace ON sessions(workspace_id);
CREATE INDEX sessions_task ON sessions(task_id);
CREATE INDEX sessions_native_file ON sessions(host_id, native_session_file);

CREATE TABLE session_items (
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE INDEX session_items_ord ON session_items(session_id, ord);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX interactions_session ON interactions(session_id);
CREATE INDEX interactions_state ON interactions(state);

CREATE TABLE panels (
  session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, adapter_id, slot)
);

CREATE TABLE host_adapters (
  host_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE adapter_renderers (
  host_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  html TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host_id, adapter_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  current_run_id TEXT,
  session_id TEXT,
  automation_id TEXT,
  grouping_key TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project_state ON tasks(project_id, state);
CREATE INDEX tasks_state ON tasks(state);
CREATE INDEX tasks_automation ON tasks(automation_id, grouping_key);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  host_id TEXT,
  dispatch_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_session ON runs(session_id);
CREATE INDEX runs_state ON runs(state);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  webhook_token_hash TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX automations_project ON automations(project_id);

CREATE TABLE occurrences (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  task_id TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (automation_id, key)
);
CREATE INDEX occurrences_automation ON occurrences(automation_id, created_at);

CREATE TABLE attention (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  project_id TEXT,
  reason TEXT NOT NULL,
  interaction_id TEXT,
  resolved_at TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX attention_open ON attention(resolved_at, reason);
CREATE INDEX attention_session ON attention(session_id);
CREATE INDEX attention_task ON attention(task_id);

CREATE TABLE push_subscriptions (
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_device ON push_subscriptions(device_id);

CREATE TABLE presence (
  device_id TEXT PRIMARY KEY,
  foreground_until TEXT,
  interacted_at TEXT,
  viewing_session_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  session_id TEXT PRIMARY KEY,
  attention_id TEXT,
  sent_to_device TEXT,
  sent_at TEXT,
  tag TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  project_id TEXT,
  host_id TEXT,
  json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_type ON events(type, seq);
CREATE INDEX events_at ON events(at);

CREATE TABLE host_events_seen (
  host_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (host_id, event_id)
);
CREATE INDEX host_events_seen_at ON host_events_seen(seen_at);
`;
