# Development

Requirements: Node 24 or newer, pnpm 12, git, and Pi `>=1.4.0 <1.6.0` on `PATH`.

```sh
pnpm i
pnpm build      # tsc -b for every TypeScript package, then the web bundle
pnpm lint       # Biome
pnpm test       # Vitest, all packages
pnpm test:e2e   # Playwright, the web app at four viewport sizes
```

For a live development loop, run `node packages/cli/dist/main.js up --dev` and, in another terminal, `pnpm --filter @switchyard/web dev` (Vite proxies the API and WebSockets to port 7400).

## Tests against real Pi

Most runtime, host and integration tests start the real `pi --mode rpc` with an isolated agent directory and a scripted OpenAI-compatible mock model from `packages/test-fixtures`, so they cost nothing and need no network. Only the model is fake.

| Variable | Effect |
|---|---|
| `SWITCHYARD_PI_BIN` | Pi binary to test against (default `pi`) |
| `SWITCHYARD_SKIP_REAL_PI=1` | Skip tests that need Pi; without it, a missing Pi fails them |
| `SWITCHYARD_PI_PLUGINS_DIR` | A Pi package suite whose Switchyard adapters the plugin compatibility tests load (skipped when absent) |

The browser tests start a real coordinator and host with the mock model, and use a mock OpenID Connect provider and a virtual WebAuthn authenticator for the sign-in flows.

## Building the npm package

The published package, `@spencerboucher/switchyard`, is one bundled CLI: `scripts/build-npm.mjs` inlines the `@switchyard/*` workspace packages into `dist/switchyard.mjs` with esbuild, keeps third-party dependencies as ordinary npm dependencies, and ships the Pi bridge extension and the web app alongside.

```sh
pnpm build && pnpm build:npm      # writes dist-npm/
bash scripts/smoke-npm.sh         # packs it, installs it into a temp prefix, runs `switchyard up`
```

## Workflow

1. **Change.** Work on a short-lived branch (or straight on `main` for a small fix). Try it locally with `up --dev` and the Vite server on their own data directory, never against a coordinator you rely on.
2. **Check.** `pnpm lint && pnpm test` always; `pnpm test:e2e` when the web app changed.
3. **Merge to `main`.** CI builds, lints and tests every push. A green push to `main` also publishes the coordinator image as `ghcr.io/justmytwospence/switchyard:edge` and `:sha-<short>` (linux/amd64).
4. **Try it on a development deployment.** Run a second coordinator on `:edge` with its own data directory, plus a second host agent on the same machine as your real one (its own `SWITCHYARD_HOST_CONFIG` and `SWITCHYARD_STATE_DIR`, enrolled with the development coordinator). It works in your real repositories and sees the Pi sessions on disk, while its tasks, runs and devices stay separate. To try a change against realistic data, restore a backup of the production database into its data directory: the copy is one way, so migrations there never touch production. Never point two coordinators at one data directory: `coordinator.lock` refuses it and schema migrations only move forward.
5. **Release.** Tag `vX.Y.Z` when production should move, or when hosts need a new CLI or host agent from npm (see below).

Coordinators and hosts are upgraded independently, so the coordinator must keep working with hosts one release behind: keep changes to the host wire protocol (`packages/protocol/src/host-wire.ts`) backward compatible, or release them so the coordinator moves first.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`:

- **image:** builds the container for linux/amd64 and linux/arm64 and publishes it to GHCR;
- **npm:** builds and smoke-tests the npm package, then publishes it with npm trusted publishing (GitHub OIDC, with provenance), skipping a version that is already on npm.

Every package shares the version in its `package.json`.
