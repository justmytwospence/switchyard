#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$root/dist-client-npm" && npm pack --pack-destination "$tmp" --silent >/dev/null)
npm install --prefix "$tmp" --ignore-scripts --no-audit --no-fund "$tmp"/*.tgz >/dev/null
cat > "$tmp/consumer.mts" <<'TS'
import { SwitchyardClient, ApiRequestError, type CreateSessionInput, type EventNotice } from "@spencerboucher/switchyard-client";
const input: CreateSessionInput = { projectId: "project", workspace: { existingId: "workspace" } };
const use = (event: EventNotice) => event.type === "reset" ? event.seq : event.event.seq;
void input; void use; void SwitchyardClient; void ApiRequestError;
TS
cat > "$tmp/tsconfig.json" <<'JSON'
{"compilerOptions":{"target":"ES2023","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"skipLibCheck":false},"files":["consumer.mts"]}
JSON
(cd "$tmp" && "$root/node_modules/.bin/tsc" -p tsconfig.json)
cat > "$tmp/fixture.mjs" <<'JS'
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { SwitchyardClient, ApiRequestError } from '@spencerboucher/switchyard-client';
import assert from 'node:assert/strict';
const http = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/tasks') { res.end('[]'); return; }
  if (req.url === '/api/sessions/404/transcript') { res.statusCode = 404; res.end('{"error":{"code":"not_found","message":"Missing"}}'); return; }
  res.statusCode = 204; res.end();
});
const ws = new WebSocketServer({ server: http, path: '/ws/client' });
ws.on('connection', (socket) => socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'hello') socket.send(JSON.stringify({ type: 'snapshot', seq: 7, state: {
    hosts: [], projects: [], checkouts: [], workspaces: [], profiles: [], views: [], sessions: [], tasks: [], runs: [], automations: [], attention: [], interactions: [], panels: [], devices: [], adapters: {}, dispatchPaused: false
  } }));
}));
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const client = new SwitchyardClient({ coordinatorUrl: `http://127.0.0.1:${http.address().port}`, credential: 'fixture' });
try {
  assert.deepEqual(await client.tasks.list(), []);
  await assert.rejects(client.sessions.transcript('404'), (error) => error instanceof ApiRequestError && error.code === 'not_found');
  const notice = new Promise((resolve) => client.events.subscribe(resolve));
  assert.equal((await notice).seq, 7);
} finally { client.close(); await new Promise((r) => ws.close(r)); await new Promise((r) => http.close(r)); }
JS
(cd "$tmp" && node fixture.mjs)
echo 'SDK tarball smoke passed'
