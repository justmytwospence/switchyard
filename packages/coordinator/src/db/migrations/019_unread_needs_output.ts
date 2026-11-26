/**
 * 019_unread_needs_output: sessions that started and went idle without a turn were marked unread
 * ("Ready to review"). Clear those marks; a session is unread only after it produced something.
 */
export const sql = `
UPDATE sessions
  SET json = json_set(json, '$.unreadSince', NULL)
  WHERE json_extract(json, '$.unreadSince') IS NOT NULL
    AND json_extract(json, '$.runtime') <> 'failed'
    AND COALESCE(json_extract(json, '$.stats.tokens'), 0) = 0
    AND COALESCE(json_extract(json, '$.lastAssistantText'), '') = '';
`;
