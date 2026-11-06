/** 008_item_rev: a per-session revision on transcript items, the cursor for delta fetches. */
export const sql = `
ALTER TABLE session_items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
CREATE INDEX session_items_rev ON session_items(session_id, rev);
`;
