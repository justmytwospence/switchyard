export const sql = `
ALTER TABLE policy_evaluations ADD COLUMN wait_lease_until TEXT;
`;
