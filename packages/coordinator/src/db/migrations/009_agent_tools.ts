/** Durable agent-call results, inbox messages and fixed creator subscriptions. */
export const sql = `
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
UPDATE tasks SET parent_task_id = json_extract(json, '$.parentTaskId');
CREATE INDEX tasks_parent ON tasks(parent_task_id);

CREATE TABLE agent_call_receipts (
  caller_session_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (caller_session_id, native_session_id, tool_call_id, method)
);

CREATE TABLE agent_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
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
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_messages_pair_time
  ON agent_messages(sender_session_id, recipient_session_id, created_at);
CREATE INDEX agent_messages_recipient_seq ON agent_messages(recipient_session_id, seq);

CREATE TABLE task_subscriptions (
  child_task_id TEXT NOT NULL,
  subscriber_session_id TEXT NOT NULL,
  parent_task_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (child_task_id, subscriber_session_id)
);
`;
