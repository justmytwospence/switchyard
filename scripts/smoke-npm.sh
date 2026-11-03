#!/usr/bin/env bash
# Packs dist-npm/, installs it into a throwaway prefix and checks the installed CLI really runs:
# version, a standalone coordinator + host, the web app and an initialized server.
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
curl -fsS "http://localhost:$port/api/setup" | grep -q '"initialized":true' || { cat "$tmp/up.log"; echo "FAIL setup"; exit 1; }
echo "ok initialized"
echo "smoke test passed"
