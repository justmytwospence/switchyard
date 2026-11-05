/** 007_views: named session filters that TUI clients bind to. */
export const sql = `
CREATE TABLE views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX views_name ON views(name COLLATE NOCASE);
`;
