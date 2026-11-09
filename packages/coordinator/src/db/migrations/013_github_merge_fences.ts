/** Write-ahead external mutation fences have no entity FKs or retention policy.
 * E.3 startup owns guarded compatibility imports; already-applied 013 data stays untouched.
 */
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
`;
