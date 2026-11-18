#!/usr/bin/env bash
# Pre-push check: Biome, the TypeScript build and the fast test tier (about 20 s), so lint, type
# and logic errors in pure code never cost a CI round trip. CI runs the whole suite. Register once
# per clone (docs/development.md); skip it for one push with git push --no-verify. It checks the
# working tree, not exactly the pushed commits.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ ! -d node_modules ]; then
  echo "pre-push: no node_modules here; run pnpm install (check skipped)" >&2
  exit 0
fi
pnpm exec biome check .
pnpm exec tsc -b
pnpm test:tiers
pnpm test:fast
