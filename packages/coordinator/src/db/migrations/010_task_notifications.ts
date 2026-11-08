/** Nullable coordinator-origin senders and immutable task-completion inbox captures. */
export const sql = `
-- Keep the AUTOINCREMENT high-water even when its highest rows were already deleted.
CREATE TEMP TABLE agent_messages_high_water AS
  SELECT seq FROM sqlite_sequence WHERE name = 'agent_messages';

CREATE TABLE agent_messages_rebuilt (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('message', 'completion')),
  sender_session_id TEXT,
  recipient_session_id TEXT NOT NULL,
  reply_to TEXT,
  chain_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  requested_mode TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  hold_until TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(kind = 'completion' OR sender_session_id IS NOT NULL),
  CHECK(sender_session_id IS NULL OR length(sender_session_id) > 0)
);
INSERT INTO agent_messages_rebuilt SELECT * FROM agent_messages;
DROP TABLE agent_messages;
ALTER TABLE agent_messages_rebuilt RENAME TO agent_messages;
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE(
  (SELECT seq FROM agent_messages_high_water), 0)) WHERE name = 'agent_messages';
INSERT INTO sqlite_sequence(name, seq)
  SELECT 'agent_messages', seq FROM agent_messages_high_water
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_messages');
DROP TABLE agent_messages_high_water;

CREATE INDEX agent_messages_pair_time
  ON agent_messages(sender_session_id, recipient_session_id, created_at);
CREATE INDEX agent_messages_recipient_seq ON agent_messages(recipient_session_id, seq);

CREATE TABLE task_completions (
  id TEXT PRIMARY KEY,
  child_task_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('review', 'done', 'failed')),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(child_task_id, outcome)
);
CREATE TABLE task_completion_recipients (
  completion_id TEXT NOT NULL,
  subscriber_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(completion_id, subscriber_session_id)
);
`;
