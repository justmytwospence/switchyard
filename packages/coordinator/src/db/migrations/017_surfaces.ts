/**
 * 017_surfaces: terminal surfaces (herdr, tmux) that show a view, under the device that reports
 * them. They replace the client list inside each view, which is emptied.
 */
export const sql = `
CREATE TABLE surfaces (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  view_id TEXT,
  last_seen_at TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX surfaces_device ON surfaces(device_id);
UPDATE views SET json = json_set(json, '$.clients', json('[]'));
`;
