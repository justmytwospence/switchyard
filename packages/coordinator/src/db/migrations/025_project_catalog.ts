export const sql = `
CREATE TABLE catalog_connections (
  id TEXT PRIMARY KEY,
  authority TEXT NOT NULL,
  account TEXT NOT NULL COLLATE NOCASE,
  json TEXT NOT NULL
);
CREATE TABLE catalog_bindings (
  authority TEXT NOT NULL,
  external_id TEXT NOT NULL,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  PRIMARY KEY (authority, external_id)
);
CREATE TABLE catalog_memberships (
  connection_id TEXT NOT NULL REFERENCES catalog_connections(id),
  authority TEXT NOT NULL,
  external_id TEXT NOT NULL,
  json TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, authority, external_id)
);
CREATE INDEX catalog_membership_repo ON catalog_memberships (authority, external_id);
CREATE TABLE catalog_conflicts (
  connection_id TEXT NOT NULL REFERENCES catalog_connections(id),
  external_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_id)
);

UPDATE projects SET json = json_set(json, '$.catalog', json_object('state', 'legacy'));
UPDATE hosts SET json = json_set(json, '$.checkoutRoot', CASE
  WHEN (SELECT COUNT(DISTINCT value) FROM json_each(hosts.json, '$.projectFolders')) = 0 THEN '~/Projects'
  WHEN (SELECT COUNT(DISTINCT value) FROM json_each(hosts.json, '$.projectFolders')) = 1
    THEN (SELECT value FROM json_each(hosts.json, '$.projectFolders') LIMIT 1)
  ELSE NULL END, '$.checkoutProvision', json('false'));

INSERT INTO settings (key, value)
VALUES ('minRetainedSeq',
        CAST(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1 AS TEXT))
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;
