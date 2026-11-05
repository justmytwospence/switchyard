/**
 * 006_unique_native_session: one Switchyard session per native Pi session file per host. Existing
 * duplicates keep one row (unarchived first, then a live runtime, then the oldest); the others
 * are archived and lose their native handle (their cached transcript stays readable).
 */
export const sql = `
UPDATE sessions SET
  archived_at = COALESCE(archived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  native_session_file = NULL,
  json = json_set(json,
    '$.archivedAt', COALESCE(json_extract(json, '$.archivedAt'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    '$.nativeHandle', NULL)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY host_id, native_session_file
      ORDER BY (archived_at IS NOT NULL),
               (runtime NOT IN ('starting', 'idle', 'running', 'waiting_input')),
               json_extract(json, '$.createdAt'), rowid
    ) AS rn
    FROM sessions WHERE native_session_file IS NOT NULL
  ) WHERE rn > 1
);
DROP INDEX IF EXISTS sessions_native_file;
CREATE UNIQUE INDEX sessions_native_file ON sessions(host_id, native_session_file)
  WHERE native_session_file IS NOT NULL;
`;
