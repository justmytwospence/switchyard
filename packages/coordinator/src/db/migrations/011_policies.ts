export const sql = `
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('session','profile','server')),
  scope_id TEXT,
  priority INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  phases TEXT NOT NULL CHECK (json_valid(phases)),
  name TEXT NOT NULL,
  expression TEXT NOT NULL,
  built_in INTEGER NOT NULL CHECK (built_in IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'server' AND scope_id IS NULL) OR (scope != 'server' AND scope_id IS NOT NULL AND length(scope_id) > 0))
);
CREATE INDEX policy_rules_scope ON policy_rules(scope, scope_id, priority, id);
CREATE TABLE policy_evaluations (
  evaluation_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task','session')),
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revisions_json TEXT NOT NULL CHECK (json_valid(revisions_json)),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  provisional_updates_json TEXT NOT NULL CHECK (json_valid(provisional_updates_json)),
  verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW','ASK','DENY')),
  decision_id TEXT NOT NULL UNIQUE,
  interaction_id TEXT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  canceled INTEGER NOT NULL DEFAULT 0 CHECK (canceled IN (0,1)),
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX policy_evaluations_session ON policy_evaluations(session_id, verdict, canceled);
CREATE TABLE policy_counters (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task','session')),
  scope_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  counters_json TEXT NOT NULL CHECK (json_valid(counters_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY(scope_kind, scope_id, rule_id)
);
CREATE TABLE policy_runtime_boundaries (
  session_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  boundary_json TEXT NOT NULL CHECK (json_valid(boundary_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, native_session_id, runtime_id)
);
CREATE TABLE policy_grants (
  id TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task','session')),
  scope_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  rule_revision INTEGER NOT NULL CHECK (rule_revision >= 1),
  fingerprint TEXT NOT NULL,
  approved_by_device_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY(scope_kind, scope_id, rule_id, rule_revision, fingerprint)
);
`;
