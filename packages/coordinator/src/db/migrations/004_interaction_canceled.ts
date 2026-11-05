/**
 * 004_interaction_canceled: the interaction state is spelled "canceled" (like task and run
 * states). Rewrites stored interactions and their durable update events.
 */
export const sql = `
UPDATE interactions SET state = 'canceled', json = json_set(json, '$.state', 'canceled') WHERE state = 'cancelled';
UPDATE events SET json = json_set(json, '$.state', 'canceled') WHERE type = 'interaction.updated' AND json_extract(json, '$.state') = 'cancelled';
`;
