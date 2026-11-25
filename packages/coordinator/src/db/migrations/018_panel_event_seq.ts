/**
 * 018_panel_event_seq: a panel remembers the journal event that carries its current state, so the
 * next update can delete it. Only a panel's latest state matters to a client that replays the
 * journal; a panel that updates often would otherwise fill it for the whole retention window.
 */
export const sql = `
ALTER TABLE panels ADD COLUMN event_seq INTEGER;
`;
