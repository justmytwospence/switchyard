/** Sparse, scope-independent associations for issues whose work was explicitly started or linked. */
export const sql = `
CREATE TABLE issue_work (
  project_id TEXT NOT NULL,
  github_issue_node_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  remote INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT,
  pending_session_id TEXT,
  PRIMARY KEY (project_id, github_issue_node_id)
);
CREATE INDEX issue_work_project_branch ON issue_work(project_id, branch);
CREATE INDEX issue_work_pending_session ON issue_work(pending_session_id);
`;
