/**
 * 015_tracked_issues: trackers keep tracked issues instead of creating tasks. Re-keys the
 * "moved once per column" and "tried this branch once" settings from task ids to issue ids so
 * write-back never moves a card twice across the change.
 */
export const sql = `
CREATE TABLE tracked_issues (
  id TEXT PRIMARY KEY,
  tracker_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tracked_issues_tracker ON tracked_issues(tracker_id);
INSERT OR REPLACE INTO settings (key, value)
  SELECT 'issueMoved:' || json_extract(t.json, '$.tracker.trackerId') || ':' ||
         json_extract(t.json, '$.tracker.itemId') ||
         substr(s.key, length('trackerMoved:' || t.id) + 1), s.value
  FROM settings s JOIN tasks t ON s.key LIKE 'trackerMoved:' || t.id || ':%'
  WHERE json_extract(t.json, '$.tracker.itemId') IS NOT NULL;
INSERT OR REPLACE INTO settings (key, value)
  SELECT 'issueBranchTried:' || json_extract(t.json, '$.tracker.trackerId') || ':' ||
         json_extract(t.json, '$.tracker.itemId') ||
         substr(s.key, length('trackerBranchTried:' || t.id) + 1), s.value
  FROM settings s JOIN tasks t ON s.key LIKE 'trackerBranchTried:' || t.id || ':%'
  WHERE json_extract(t.json, '$.tracker.itemId') IS NOT NULL;
DELETE FROM settings WHERE key LIKE 'trackerMoved:%' OR key LIKE 'trackerBranchTried:%';
`;
