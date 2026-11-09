/** Write-ahead external mutation fences have no entity FKs or retention policy. */
export const sql = `
CREATE TABLE github_merge_fences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fence_key TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  pull_request_node_id TEXT,
  repository TEXT NOT NULL COLLATE NOCASE,
  pr_number INTEGER NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  expected_head_oid TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  head_repository TEXT,
  head_ref_name TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','unknown')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX github_merge_fences_target ON github_merge_fences(hostname, repository, pr_number);

INSERT OR IGNORE INTO github_merge_fences
  (fence_key, hostname, repository, pr_number, attempt_id, command_id,
   expected_head_oid, workspace_id, host_id, head_repository, head_ref_name,
   state, started_at, updated_at)
SELECT 'legacy:github.com:' || lower(json_extract(json, '$.github.repository')) || ':' ||
    json_extract(json, '$.github.pullRequest.number'),
  'github.com', json_extract(json, '$.github.repository'),
  json_extract(json, '$.github.pullRequest.number'),
  'legacy:' || id, 'legacy:' || id,
  COALESCE(json_extract(json, '$.github.pullRequest.headRefOid'), ''), id, host_id,
  json_extract(json, '$.github.headRepository'), json_extract(json, '$.github.branch'),
  'unknown', COALESCE(json_extract(json, '$.github.attemptedAt'), datetime('now')),
  COALESCE(json_extract(json, '$.github.attemptedAt'), datetime('now'))
FROM workspaces
WHERE json_extract(json, '$.github.reason') = 'Merge outcome unknown. Refresh before retrying.'
  AND length(trim(json_extract(json, '$.github.repository'))) > 0
  AND json_type(json, '$.github.pullRequest.number') = 'integer'
  AND json_extract(json, '$.github.pullRequest.number') > 0;

-- With no recoverable target, no PR can be proved unrelated. Retain the corrupt audit
-- marker independently of workspace lifetime; only manual reconciliation can remove it.
INSERT OR IGNORE INTO settings(key, value)
SELECT 'githubCorruptedMergeMarker:' || id, json
FROM workspaces
WHERE json_extract(json, '$.github.reason') = 'Merge outcome unknown. Refresh before retrying.'
  AND NOT (
    COALESCE(length(trim(json_extract(json, '$.github.repository'))), 0) > 0
    AND COALESCE(json_type(json, '$.github.pullRequest.number'), '') = 'integer'
    AND COALESCE(json_extract(json, '$.github.pullRequest.number'), 0) > 0
  );
`;
