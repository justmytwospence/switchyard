/**
 * 021_terminals: surfaces become terminals, every herdr or tmux session Switchyard knows about,
 * with a recorded binding (`mirror`: none, all or view). A surface that showed a view keeps it as
 * its recorded binding; one without a view records nothing, so its daemon may seed one once. The
 * durable `surface.*` events are renamed to `terminal.*`.
 */
export const sql = `
ALTER TABLE surfaces RENAME TO terminals;
DROP INDEX surfaces_device;
CREATE INDEX terminals_device ON terminals(device_id);
UPDATE terminals SET json = json_set(
  json,
  '$.mirror', CASE WHEN view_id IS NULL THEN 'none' ELSE 'view' END,
  '$.bindingSetAt', CASE WHEN view_id IS NULL THEN NULL ELSE last_seen_at END,
  '$.shows', json('[]')
);
UPDATE events SET type = 'terminal.updated' WHERE type = 'surface.updated';
UPDATE events SET type = 'terminal.deleted' WHERE type = 'surface.deleted';
`;
