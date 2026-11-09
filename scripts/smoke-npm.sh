#!/usr/bin/env bash
# Packs dist-npm/, installs it into a throwaway prefix and checks the installed CLI really runs:
# version, a standalone coordinator + host, the web app and the sign-in state.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${SMOKE_PORT:-7499}"
tmp="$(mktemp -d)"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

version="$(node -p "require('$root/dist-npm/package.json').version")"
tarball="$(cd "$tmp" && npm pack "$root/dist-npm" --silent)"
echo "packed $tarball"
npm install -g --prefix "$tmp/prefix" "$tmp/$tarball" --silent
bin="$tmp/prefix/bin/switchyard"

got="$("$bin" --version)"
[[ "$got" == "$version" ]] || { echo "FAIL version: $got != $version"; exit 1; }
echo "ok version $got"

HOME="$tmp/home" SWITCHYARD_HOST_CONFIG="$tmp/home/host.json" SWITCHYARD_STATE_DIR="$tmp/home/state" \
  "$bin" up --port "$port" --data-dir "$tmp/data" --no-open >"$tmp/up.log" 2>&1 &
pid=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/healthz" 2>/dev/null | grep -q '"ok":true'; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$port/healthz" | grep -q '"ok":true' || { cat "$tmp/up.log"; echo "FAIL healthz"; exit 1; }
echo "ok healthz"
curl -fsS "http://localhost:$port/" | grep -q 'id="root"' || { echo "FAIL web app"; exit 1; }
echo "ok web app"
curl -fsS "http://localhost:$port/api/setup" | grep -q '"passkey"' || { cat "$tmp/up.log"; echo "FAIL setup"; exit 1; }
echo "ok sign-in"

# Exercise the installed, separately bundled worker, not a source-tree fallback.
node --input-type=module - "$bin" <<'JS'
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
const worker = new Worker(join(dirname(realpathSync(process.argv[2])), "policies", "worker.js"), {
  execArgv: [],
  resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
});
const rule = {
  id: "smoke", scope: "server", scopeId: null, priority: 0, revision: 1,
  enabled: true, phases: ["request"], name: "Packaged worker smoke",
  expression: '{"verdict":"ALLOW","reason":"packaged worker"}', builtIn: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const context = {
  phase: "request", action: "inbox.read", tool: null,
  request: { method: "inbox.read", args: {} }, task: null, target: null,
  session: {
    id: "session", hostId: "host", nativeSessionId: null, runtimeId: null,
    profileId: "profile", projectId: null, taskId: null, runId: null,
    controlMode: "human", controlRevision: 1, cwd: "/tmp", workspaceRoot: "/tmp",
    repository: null, defaultBranch: null, readOnly: false,
  },
  cost: {
    tokens: null, costUsd: null, maxTokens: null, maxCostUsd: null,
    accounting: "unavailable", fresh: false, watermark: null, provider: null,
    modelId: null, classification: "unclassified", expensive: true,
  },
};
const timer = setTimeout(() => { console.error("FAIL packaged policy worker timeout"); process.exit(1); }, 7000);
try {
  await new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => reject(new Error(`Policy worker exited: ${code}`)));
    worker.on("message", (reply) => {
      try {
        if (reply.type === "ready") worker.postMessage({ id: 1, job: { type: "validate", rule } });
        else if (reply.id === 1) {
          assert.deepEqual(reply, { type: "result", id: 1, value: { valid: true, returnType: "map<string, string>" } });
          worker.postMessage({ id: 2, job: { type: "evaluate", rules: [rule], context, countersByRule: {} } });
        } else {
          assert.equal(reply.type, "result");
          assert.deepEqual(reply.value, [{ ruleId: "smoke", ruleRevision: 1, result: { verdict: "ALLOW", reason: "packaged worker" }, error: null }]);
          resolve();
        }
      } catch (error) { reject(error); }
    });
  });
} finally { clearTimeout(timer); await worker.terminate(); }
console.log("ok packaged policy worker");
JS
echo "smoke test passed"
