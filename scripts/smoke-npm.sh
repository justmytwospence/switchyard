#!/usr/bin/env bash
# Packs dist-npm/, installs it into a throwaway prefix and checks the installed CLI really runs:
# version, a standalone coordinator + host, the web app and the sign-in state.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${SMOKE_PORT:-7499}"
tmp="$(mktemp -d)"
pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    if ! wait "$pid"; then
      echo "FAIL smoke process cleanup (temporary files retained)" >&2
      [[ "$status" -ne 0 ]] || status=1
      exit "$status"
    fi
  fi
  rm -rf "$tmp" || { [[ "$status" -ne 0 ]] || status=1; }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

version="$(node -p "require('$root/dist-npm/package.json').version")"
tarball="$(cd "$tmp" && npm pack "$root/dist-npm" --silent)"
echo "packed $tarball"
npm install -g --prefix "$tmp/prefix" "$tmp/$tarball" --silent
bin="$tmp/prefix/bin/switchyard"

got="$("$bin" --version)"
[[ "$got" == "$version" ]] || { echo "FAIL version: $got != $version"; exit 1; }
echo "ok version $got"

HOME="$tmp/home" PI_CODING_AGENT_DIR="$tmp/home/pi" \
  SWITCHYARD_HOST_CONFIG="$tmp/home/host.json" SWITCHYARD_STATE_DIR="$tmp/home/state" \
  SWITCHYARD_OIDC_ISSUER= SWITCHYARD_OIDC_CLIENT_ID= SWITCHYARD_PUBLIC_URL= \
  SWITCHYARD_HOST_ENROLL_SECRET= SWITCHYARD_TRUSTED_PROXIES= SWITCHYARD_TRUSTED_ORIGINS= \
  node --input-type=module - "$bin" "$port" "$tmp" <<'JS' &
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

const [bin, port, tmp] = process.argv.slice(2);
// Install handlers before starting anything; an early shell exit must not strand up.
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const log = openSync(`${tmp}/up.log`, "a", 0o600);
// Node's detached spawn creates a private POSIX session/process group on both macOS and
// Linux; no setsid utility or job-control assumptions. Never signal the caller's group.
const child = spawn(bin, ["up", "--bind", "127.0.0.1", "--port", port,
  "--data-dir", `${tmp}/data`, "--no-open"], {
  detached: true, stdio: ["ignore", log, log],
});
closeSync(log);
let exited = false;
const reaped = new Promise((resolve) => {
  child.once("exit", () => { exited = true; resolve(); });
  child.once("error", () => { exited = true; resolve(); });
});
const owned = new Map();
const groups = new Set();
let scanFailed = false;
function scan() {
  // No arguments or environment in ps output: those can contain credentials. lstart
  // guards recorded identities against PID reuse. Zombies cannot write and await their
  // own parent/reaper; our direct child is additionally waited for via `reaped`.
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).trim().split("\n").map((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) throw new Error("Invalid process snapshot");
    return { pid: +m[1], parent: +m[2], group: +m[3], zombie: m[4].startsWith("Z"), start: m[5] };
  });
  const current = new Map(rows.map((p) => [p.pid, p]));
  for (const [pid, start] of owned) {
    if (current.get(pid)?.start !== start) owned.delete(pid);
  }
  if (!exited && current.has(child.pid)) owned.set(child.pid, current.get(child.pid).start);
  // Retire empty groups before discovering new members: a group ID must not become
  // authority to signal unrelated processes if that numeric ID is eventually reused.
  for (const group of groups) {
    if (!rows.some((p) => p.group === group && owned.has(p.pid))) groups.delete(group);
  }
  // Holders detach into new sessions, and node-pty gives Pi its own group too. Discover
  // those while `up` is alive, retaining identities/groups if they later get reparented.
  let added;
  do {
    added = false;
    for (const p of rows) {
      if (!owned.has(p.pid) && (owned.has(p.parent) || groups.has(p.group))) {
        owned.set(p.pid, p.start);
        added = true;
      }
      if (owned.has(p.pid) && p.pid === p.group) groups.add(p.group);
    }
  } while (added);
  return rows.filter((p) => owned.get(p.pid) === p.start && !p.zombie);
}
// Keep this supervisor alive until the shell asks for cleanup, even if `up` exits early.
// Capture detached children before their parent can disappear; the private up group
// also catches inherited-group children after an early coordinator exit.
if (child.pid) groups.add(child.pid);
const watcher = setInterval(() => {
  try { scan(); } catch { scanFailed = true; }
}, 100);
try { scan(); } catch { scanFailed = true; }
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(watcher);
  try {
    const started = Date.now();
    const signalled = new Map();
    for (;;) {
      const live = scan();
      if (live.length === 0) break;
      if (Date.now() - started > 20000) throw new Error("Processes did not stop");
      const signal = Date.now() - started < 15000 ? "SIGTERM" : "SIGKILL";
      // Children first, up last. Keep scanning during shutdown for in-flight spawns.
      for (const p of live.sort((a, b) => (a.pid === child.pid) - (b.pid === child.pid))) {
        const key = `${p.pid}:${p.start}`;
        if (signalled.get(key) === signal) continue;
        try { process.kill(p.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
        signalled.set(key, signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await reaped;
    process.exit(scanFailed ? 1 : 0);
  } catch {
    // Do not print error objects, CLI output, or environment: they may contain tokens.
    process.exit(1);
  }
}
JS
pid=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/healthz" 2>/dev/null | grep -q '"ok":true'; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$port/healthz" | grep -q '"ok":true' || { echo "FAIL healthz (coordinator output withheld: it may contain sign-in credentials)"; exit 1; }
echo "ok healthz"
curl -fsS "http://localhost:$port/" | grep -q 'id="root"' || { echo "FAIL web app"; exit 1; }
echo "ok web app"
curl -fsS "http://localhost:$port/api/setup" | grep -q '"passkey"' || { echo "FAIL setup"; exit 1; }
echo "ok sign-in"

# Create a local checkout and start a real packaged-host Pi session without prompting a model.
# The coordinator's local admin credential stays in this process, never in arguments or logs.
mkdir -p "$tmp/repo"
git -C "$tmp/repo" init -q
git -C "$tmp/repo" -c user.name=Smoke -c user.email=smoke@example.invalid commit -q --allow-empty -m initial
node --input-type=module - "$port" "$tmp/data/admin.token" "$tmp/repo" <<'JS'
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";

const [port, tokenPath, repo] = process.argv.slice(2);
const base = `http://localhost:${port}`;
const token = readFileSync(tokenPath, "utf8").trim();
async function api(method, path, body, authenticated = true) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function ok(method, path, body, status = 200) {
  const result = await api(method, path, body);
  if (result.status !== status) throw new Error(`${method} ${path}: HTTP ${result.status} (${result.data.error?.code ?? "unexpected response"})`);
  return result.data;
}
async function waitFor(label, fn) {
  for (let i = 0; i < 120; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
assert.equal((await api("GET", "/api/policies", undefined, false)).status, 401);
const host = await waitFor("local host", async () =>
  (await ok("GET", "/api/hosts")).find((h) => h.connectivity === "connected" && h.piCompatible));
const project = await ok("POST", "/api/projects", {
  name: "Packaged policy smoke", hostId: host.id, path: realpathSync(repo),
}, 201);
const workspace = project.workspaces.find((w) => w.provenance === "main");
assert.ok(workspace, "main workspace discovered");
const session = await ok("POST", "/api/sessions", {
  projectId: project.id, workspace: { existingId: workspace.id }, prompt: "", title: "Policy smoke",
}, 202);
await waitFor("active policy bridge", async () => {
  const current = await ok("GET", `/api/sessions/${session.id}`);
  if (["failed", "stopped", "interrupted"].includes(current.runtime)) throw new Error(`Session ${current.runtime}`);
  return current.bridge?.policyState === "active" && current.bridge.policyPhases.includes("request");
});
const rule = await ok("POST", "/api/policies", {
  scope: "server", scopeId: null, priority: 0, enabled: true, phases: ["request"],
  name: "Packaged policy smoke", expression: '{"verdict":"DENY","reason":"packaged API smoke"}',
}, 201);
assert.ok((await ok("GET", "/api/policies")).some((r) => r.id === rule.id && r.expression === rule.expression));
const result = await ok("POST", "/api/policies/test", {
  sessionId: session.id, phase: "request", tool: null, request: { method: "inbox.read", args: {} },
});
assert.equal(result.verdict, "DENY");
assert.equal(result.reason, "packaged API smoke");
assert.ok(result.trace.some((entry) => entry.ruleId === rule.id && entry.ruleRevision === rule.revision && entry.verdict === "DENY"));
console.log("ok packaged coordinator persisted policy verdict");
JS

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
