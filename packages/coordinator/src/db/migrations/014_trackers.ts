/** 014_trackers: GitHub trackers that sync assigned issues into tasks. */
export const sql = `
CREATE TABLE trackers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX trackers_name ON trackers(name COLLATE NOCASE);
`;
