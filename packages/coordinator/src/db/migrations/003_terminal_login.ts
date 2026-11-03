/**
 * 003_terminal_login: allow terminal_login flows. Flows live minutes, so the table is
 * recreated empty.
 */
export const sql = `
DROP TABLE auth_flows;

CREATE TABLE auth_flows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('passkey_register','passkey_auth','oidc','terminal_login')),
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
