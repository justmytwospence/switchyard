/**
 * 022_terminal_presence: presence per device and terminal. A herdr or tmux daemon reports the
 * session focused in its terminal under the CLI's device, next to that device's own presence
 * (`terminal_id` '' is the device itself). Presence is ephemeral, so the old rows are dropped.
 */
export const sql = `
DROP TABLE presence;
CREATE TABLE presence (
  device_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL DEFAULT '',
  foreground_until TEXT,
  interacted_at TEXT,
  viewing_session_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, terminal_id)
);
`;
