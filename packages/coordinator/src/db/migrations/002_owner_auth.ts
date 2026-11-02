/**
 * 002_owner_auth: owner passkeys, short-lived sign-in flows (passkey challenges, OIDC state),
 * and the `owner.initialized_at` marker for servers that already have enrolled devices.
 *
 * `passkeys.id` and `passkeys.public_key` are base64url; `auth_flows.data` is JSON. Settings
 * values are JSON, so the timestamp is stored JSON-quoted.
 */
export const sql = `
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE auth_flows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('passkey_register','passkey_auth','oidc')),
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value)
  SELECT 'owner.initialized_at', json_quote(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE EXISTS (SELECT 1 FROM devices WHERE is_admin = 0 AND revoked_at IS NULL);
`;
