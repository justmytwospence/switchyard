/**
 * 023_scopes_clients: views and trackers merge into scopes, and terminals become clients.
 *
 * - A view no tracker keeps becomes a scope with the same id and no source.
 * - A tracker becomes a scope with the tracker's id (tracked-issue ids and the `issueMoved:` and
 *   `issueBranchTried:` settings are keyed by it), taking its view's name, mode, projects and pins;
 *   the tracker itself is the scope's `source`. A tracker that never synced adopts the view of
 *   its name, as its first sync would have; one with no view gets an empty scope.
 * - `terminals` becomes `clients`: `viewId` is `scopeId` (following a view to its tracker's
 *   scope), and `mirror: "view"` is `"scope"`. A binding to a view that is gone mirrors nothing.
 * - Tracked issues gain `scopeId` (and keep `trackerId` for 0.20 clients); presence is keyed by
 *   `client_id`.
 * - `minRetainedSeq` moves past the last event, so every client takes a snapshot at its next
 *   connection and the stored `view.*` and `terminal.*` events are never replayed. They stay
 *   until retention removes them.
 *
 * One-way: back up before upgrading (docs/operations.md).
 */
export const sql = `
CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TEMP TABLE scope_map AS
  SELECT t.id AS scope_id,
         COALESCE(
           (SELECT v.id FROM views v WHERE json_extract(v.json, '$.trackerId') = t.id
              ORDER BY v.created_at, v.rowid LIMIT 1),
           (SELECT v.id FROM views v WHERE json_extract(v.json, '$.trackerId') IS NULL
              AND v.name = t.name COLLATE NOCASE LIMIT 1)
         ) AS view_id
  FROM trackers t;
INSERT INTO scopes (id, name, json, created_at)
  SELECT v.id, v.name,
         json_set(json_remove(v.json, '$.clients', '$.trackerId'), '$.source', NULL),
         v.created_at
  FROM views v
  WHERE v.id NOT IN (SELECT view_id FROM scope_map WHERE view_id IS NOT NULL)
  ORDER BY v.created_at, v.rowid;
INSERT INTO scopes (id, name, json, created_at)
  SELECT t.id, v.name,
         json_set(
           json_remove(v.json, '$.clients', '$.trackerId'),
           '$.id', t.id,
           '$.source', json(json_set(
             json_remove(t.json, '$.id', '$.name', '$.provider', '$.createdAt', '$.updatedAt'),
             '$.kind', 'github'))
         ),
         v.created_at
  FROM trackers t
  JOIN scope_map m ON m.scope_id = t.id
  JOIN views v ON v.id = m.view_id
  ORDER BY v.created_at, v.rowid;
INSERT INTO scopes (id, name, json, created_at)
  SELECT t.id, n.name,
         json_object(
           'id', t.id,
           'name', n.name,
           'mode', 'all',
           'projectIds', json('[]'),
           'hostIds', NULL,
           'sessionIds', json('[]'),
           'source', json(json_set(
             json_remove(t.json, '$.id', '$.name', '$.provider', '$.createdAt', '$.updatedAt'),
             '$.kind', 'github')),
           'createdAt', json_extract(t.json, '$.createdAt'),
           'updatedAt', json_extract(t.json, '$.updatedAt')
         ),
         t.created_at
  FROM trackers t
  JOIN scope_map m ON m.scope_id = t.id AND m.view_id IS NULL
  JOIN (
    SELECT t2.id AS id,
           CASE WHEN EXISTS (SELECT 1 FROM views v2 WHERE v2.name = t2.name COLLATE NOCASE)
                THEN substr(t2.name, 1, 40) || ' ' || substr(t2.id, -8)
                ELSE t2.name END AS name
    FROM trackers t2
  ) n ON n.id = t.id
  ORDER BY t.created_at, t.rowid;
CREATE UNIQUE INDEX scopes_name ON scopes(name COLLATE NOCASE);

ALTER TABLE terminals RENAME TO clients;
ALTER TABLE clients RENAME COLUMN view_id TO scope_id;
DROP INDEX terminals_device;
CREATE INDEX clients_device ON clients(device_id);
UPDATE clients SET scope_id = (SELECT m.scope_id FROM scope_map m WHERE m.view_id = clients.scope_id)
  WHERE scope_id IN (SELECT view_id FROM scope_map WHERE view_id IS NOT NULL);
UPDATE clients SET scope_id = NULL
  WHERE scope_id IS NOT NULL AND scope_id NOT IN (SELECT id FROM scopes);
UPDATE clients SET json = json_set(
  json_remove(json, '$.viewId'),
  '$.scopeId', scope_id,
  '$.mirror', CASE
    WHEN json_extract(json, '$.mirror') = 'all' THEN 'all'
    WHEN scope_id IS NOT NULL AND COALESCE(json_extract(json, '$.mirror'), 'view') = 'view' THEN 'scope'
    ELSE 'none' END
);

ALTER TABLE tracked_issues RENAME COLUMN tracker_id TO scope_id;
DROP INDEX tracked_issues_tracker;
CREATE INDEX tracked_issues_scope ON tracked_issues(scope_id);
DELETE FROM tracked_issues WHERE scope_id NOT IN (SELECT id FROM scopes);
UPDATE tracked_issues SET json = json_set(json, '$.scopeId', scope_id);

ALTER TABLE presence RENAME COLUMN terminal_id TO client_id;

DROP TABLE scope_map;
DROP TABLE views;
DROP TABLE trackers;

INSERT INTO settings (key, value)
  VALUES ('minRetainedSeq',
          CAST(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1 AS TEXT))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;
