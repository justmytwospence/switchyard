/**
 * 016_session_links: backfill `Session.parentSessionId` for subagent sessions (from the parent's
 * `subagent` transcript items) and `Session.startedIn` for enrolled sessions (from
 * `external.client`).
 */
export const sql = `
CREATE TEMP TABLE _subagent_parents AS
  SELECT json_extract(json, '$.data.linkedSessionId') AS child, MIN(session_id) AS parent
  FROM session_items
  WHERE json LIKE '%"kind":"subagent"%'
    AND json_extract(json, '$.data.linkedSessionId') IS NOT NULL
  GROUP BY 1;
UPDATE sessions SET json = json_set(json, '$.parentSessionId',
    (SELECT parent FROM _subagent_parents WHERE child = sessions.id))
  WHERE id IN (SELECT child FROM _subagent_parents);
DROP TABLE _subagent_parents;
UPDATE sessions SET json = json_set(json, '$.startedIn', json_extract(json, '$.external.client'))
  WHERE json_extract(json, '$.external.client') IS NOT NULL;
`;
