# Development

Requirements: Node 24 or newer, pnpm 12, git, and Pi `>=1.4.0 <1.7.0` on `PATH`. For feature placement, failure behavior and compatibility expectations, see the [core/plugin ownership contract](plugin-boundaries.md).

```sh
pnpm i
pnpm build      # tsc -b for every TypeScript package, then the web bundle
pnpm lint       # Biome
pnpm test       # Vitest, all packages
pnpm test:fast  # Vitest without slow files (no coordinator, Pi or processes), seconds
pnpm test:e2e   # Playwright: every spec on desktop, layout specs at compact and phone sizes
pnpm test:e2e:smoke  # the @smoke subset CI runs
```

Register the pre-push check once per clone (worktrees share it): `git config hook.switchyard-check.command scripts/pre-push.sh && git config hook.switchyard-check.event pre-push`. It runs Biome, `tsc -b` and `pnpm test:fast`.

Test files that start a coordinator, Pi, a mock model, a child process or a worker, or listen on a port, begin with `// @module-tag slow`. `pnpm test:tiers` (run by the hook and CI) rejects untagged ones. Tag by hand any other file that takes more than about half a second.

For a live development loop, run `node packages/cli/dist/main.js up --dev` and, in another terminal, `pnpm --filter @switchyard/web dev` (Vite proxies the API and WebSockets to port 7400).

## Tests against real Pi

Most runtime, host and integration tests start the real `pi --mode rpc` with an isolated agent directory and a scripted OpenAI-compatible mock model from `packages/test-fixtures`, so they cost nothing and need no network. Only the model is fake.

| Variable | Effect |
|---|---|
| `SWITCHYARD_PI_BIN` | Pi binary to test against (default `pi`) |
| `SWITCHYARD_SKIP_REAL_PI=1` | Skip tests that need Pi; without it, a missing Pi fails them |
| `SWITCHYARD_PI_PLUGINS_DIR` | Pi suite checkout for plugin compatibility tests; direct Vitest invocation can skip when absent, but the required cross-repository check cannot |

The browser tests start a real coordinator and host with the mock model, and use a mock OpenID Connect provider and a virtual WebAuthn authenticator for the sign-in flows.

## Plugin development skill

The public [plugin-development skill](../skills/switchyard-plugin-development/SKILL.md) bundles authoring and verification references for portable use outside this repository. For example, install copies for Codex and Claude Code (choose the agents you use):

```sh
npx skills add justmytwospence/switchyard -s switchyard-plugin-development -a codex claude-code --copy -y
```

For reproducible installations, replace the repository shorthand with `https://github.com/justmytwospence/switchyard/tree/<full-commit-sha>/skills/switchyard-plugin-development`. Update deliberately by reinstalling the skill from a reviewed new commit, rather than editing installed copies. Run `pnpm skill:check` to validate the source and its validator tests. Publishing guidance on the public development branch requires no runtime release or production promotion.

## Adapter development and cross-repository checks

After `pnpm build`, run the portable preview with an explicitly selected trusted adapter and a fixture:

```sh
pnpm adapter:preview -- --adapter packages/adapter-examples/src/hello --fixture packages/adapter-examples/fixtures/hello.json > /tmp/hello-preview.json
```

Upload the JSON file in Settings > Adapters > Portable UI preview. It validates and renders desktop and phone portable UI and logs simulated actions locally as labeled fields. Use read-only simulation to disable actions and Clear preview to discard the preview and log; it does not run custom HTML or dispatch to Pi. The CLI executes adapter code with ordinary Node privileges in a separate process, **not a sandbox**; the runner creates no live Pi, model or host, but trusted adapter code can. See [the example](../packages/adapter-examples/README.md) and [adapter reload and discovery](adapters.md#inspection-and-reload).

The required Switchyard-side compatibility check is `pnpm test:plugins` after building Switchyard and installing the suite dependencies. It uses `.github/compat-pi-plugins.json`'s immutable commit and version, real Pi, and a clean suite and Switchyard checkout; the suite defaults to `../pi-plugins` or `SWITCHYARD_PI_PLUGINS_DIR`. CI checks out the pin and does not permit dirty overrides or skipping real Pi. For local paired development, explicitly set `SWITCHYARD_PI_PLUGINS_DIR` and use `pnpm test:plugins -- --allow-dirty`; add `--current-suite` to check a clean unpinned suite. These modes are not evidence for the pinned CI pair. In pi-plugins, `node scripts/check-switchyard.mjs` runs the reverse check, selecting the core checkout with `SWITCHYARD_DIR`; CI enforces its own immutable core pin and clean checkouts. Both scripts print the revisions they check.

## Building the npm package

The published package, `@spencerboucher/switchyard`, is one bundled CLI: `scripts/build-npm.mjs` inlines the `@switchyard/*` workspace packages into `dist/switchyard.mjs` with esbuild, keeps third-party dependencies as ordinary npm dependencies, and ships the Pi bridge extension and the web app alongside.

```sh
pnpm build && pnpm build:npm      # writes dist-npm/
bash scripts/smoke-npm.sh         # packs it, installs it into a temp prefix, runs `switchyard up`
pnpm build:client-npm            # writes dist-client-npm/ for the typed Node SDK
pnpm test:client-npm             # packs and checks SDK imports, declarations, REST and WS
```

## Workflow

1. **Change** on `dev` (the main checkout's branch), or on a branch in `.worktrees/<branch>` from `dev` for larger or parallel work, merged back into `dev`. Never commit to `main` directly.
2. **Check.** The pre-push hook runs lint, the TypeScript build and the fast tier. Run the tests of the packages you touched (`pnpm exec vitest run --project coordinator`; project names are the package directory names), and `pnpm test:e2e` when the web app changed. CI runs the whole suite in 5 parallel jobs on every push, plus a browser smoke test.
3. **Preview a branch.** CI builds, lints and tests every push, and every push to a branch other than `main` and `dev` publishes `ghcr.io/justmytwospence/switchyard:br-<slug>` and `:sha-<short>` (linux/amd64; `scripts/preview-slug.sh <branch>` gives the slug) as soon as the image builds, while the tests keep running. `scripts/preview.sh up`, run from the branch's worktree, deploys it as a throwaway preview at `https://<slug>.<preview domain>`: a coordinator on the development server (`scripts/lib.sh` names it and the domain) with its own data and pairing-only sign-in (`SWITCHYARD_PAIRING_ONLY`, [auth.md](auth.md)), plus a host agent on your workstation running the worktree's build (launchd `com.switchyard.host.pv-<slug>`). It prints a single-use sign-in link; `pair` prints another, `down` removes the preview, `ls` lists them and `prune` removes those whose branch is gone or merged into `dev`.
4. **Deploy `dev`.** A push to `dev` publishes `:dev` and `:sha-<short>` once the image builds (the tests run alongside). `scripts/deploy-dev.sh`, run from the main checkout, deploys it to the dev deployment: it waits for the `:dev` image, recreates the dev coordinator and the development server's host, checks the running revision, and rebuilds (alongside CI) and restarts your workstation's dev host agent, and prints where the still-running tests can be followed. Anything handed over for review goes to a preview or dev first (see AGENTS.md).

   The dev deployment is a second coordinator on `:dev` with its own data directory, plus a second host agent on the same machine as your real one (its own `SWITCHYARD_HOST_CONFIG` and `SWITCHYARD_STATE_DIR`, enrolled with the development coordinator). On a Mac or Linux workstation, install it as a second service: `node packages/cli/dist/main.js host enroll --coordinator <dev coordinator URL> --token <token> --config <dir>/host.json`, then `node packages/cli/dist/main.js host install-service --instance dev --config <dir>/host.json --state-dir <dir>`; it runs the build of the checkout it was installed from (the main checkout), so `pnpm build` and restart it (`launchctl kickstart -k gui/$(id -u)/com.switchyard.host.dev`) to update it. It works in your real repositories and sees the Pi sessions on disk, while its tasks, runs and devices stay separate. To try a change against realistic data, restore a backup of the production database into its data directory: the copy is one way, so migrations there never touch production. Never point two coordinators at one data directory: `coordinator.lock` refuses it and schema migrations only move forward.
5. **Promote, then release.** `scripts/promote.sh` fast-forwards `main` to the CI-green `dev` (the whole run, tests and browser smoke included, must have passed). Tag `vX.Y.Z` on `main` when production should move, or when hosts need a new CLI or host agent from npm (see below); `release.yml` refuses a tag that is not on `main`.

Coordinators and hosts are upgraded independently, so the coordinator must keep working with hosts one release behind: keep changes to the host wire protocol (`packages/protocol/src/host-wire.ts`) backward compatible, or release them so the coordinator moves first.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml` (only after promotion and explicit release approval):

- **image:** builds the container on native linux/amd64 and linux/arm64 runners and publishes one multi-platform tag to GHCR;
- **npm:** builds and smoke-tests both the CLI and `@spencerboucher/switchyard-client` SDK, then publishes each with npm trusted publishing (GitHub OIDC, with provenance), skipping an exact version that is already on npm. First publication of the SDK may require configuring its trusted publisher in npm; do not substitute a long-lived npm token. See [client-sdk.md](client-sdk.md).

Every package shares the version in its `package.json`.
