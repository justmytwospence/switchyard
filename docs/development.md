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

## Releases

Pushing a `v*` tag builds the container image for linux/amd64 and linux/arm64 and publishes it to GHCR (`.github/workflows/release.yml`). Every package shares the version in its `package.json`.
