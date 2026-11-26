/**
 * 020_drop_view_sources: a view is a part of your work, not a terminal. Remove `View.clientId`
 * (the terminal a view collected sessions from) and `Session.startedIn` (what it matched). Such a
 * view keeps its mode, filters and pins.
 */
export const sql = `
UPDATE views SET json = json_remove(json, '$.clientId')
  WHERE json_type(json, '$.clientId') IS NOT NULL;
UPDATE sessions SET json = json_remove(json, '$.startedIn')
  WHERE json_type(json, '$.startedIn') IS NOT NULL;
`;
