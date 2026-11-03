# Acceptance report

Status of each spec requirement from section 1 (the acceptance journey) and section 19 (verification). Recorded 2026-11-02 on macOS (Darwin arm64), Node 26.13, Pi 1.4.0, pi-plugins `bbc6ce56`.

- **Verified**: an automated test that exercises the real component passes. The test is named.
- **Unverified**: not exercised for real here. The reason is stated. A simulated pass is never counted.

"Real Pi" means the installed `pi --mode rpc` binary with an isolated agent dir and a scripted OpenAI-compatible mock model (`packages/test-fixtures`). The model is the only fake. Pi, its RPC protocol, extensions, session files, git and SQLite are all real.

## Commands

| Command | Result |
|---|---|
| `pnpm build` | passes |
| `pnpm lint` | passes |
| `pnpm test` | 499 tests pass, no real-Pi test skipped (macOS locally; also green on GitHub Actions ubuntu with Pi 1.4.0 installed) |
| `pnpm exec playwright test` | 78 passed; 54 skipped are viewport-specific specs outside their project |
| `docker build .` | Unverified: Docker Desktop on this Mac could not read registry credentials from the locked keychain in a non-interactive session |

## Section 1: acceptance journey

All steps run in one test, `packages/coordinator/test/integration/journey.test.ts`, against a real coordinator, real host agent and real Pi.

| Step | Status | Evidence |
|---|---|---|
| Task created on the phone (PWA device) and made Ready | Verified | journey: phone device creates the task through the API |
| Coordinator dispatches it to the host | Verified | journey; `dispatch-dedupe.test.ts` |
| Repo-local worktree `<repo>/.worktrees/<branch-slug>` | Verified | journey; `worktrees.test.ts` |
| Pi starts with extensions; a plugin asks a question | Verified | journey (fixture extension); real plugins in `adapter-examples/test/compat/*` |
| Desktop answers; all clients see the answer | Verified | journey; `interaction-race.test.ts` |
| Terminal attaches, takes over, returns to automation | Verified | journey (terminal device); `takeover-race.test.ts`, `takeover-launch.test.ts` |
| Task finishes into Review | Verified | journey |
| A notification opens the result | Partly verified | Routing, tag and deep link `/tasks/<id>` verified with a stubbed push sender (journey, `notifications.test.ts`); deep links through enrollment and reconnect verified in Playwright `shared.spec.ts`. Real OS delivery and click: Unverified (see below) |
| Restarting the coordinator never duplicates the run | Verified | journey; `coordinator-restart.test.ts`; `coordinator-restart-checks.test.ts` |
| Dispatch to a remote host | Verified separately | The journey test runs host and coordinator on one machine; dispatch to a remote Linux host was verified in a live deployment |

## Section 19: automated coverage

| Requirement | Status | Tests |
|---|---|---|
| Real Pi question/answer, resume, abort | Verified | `pi-runtime/test/gate-*.test.ts` |
| Simultaneous terminal and web access to one native session | Verified | `integration/shared-session.test.ts` |
| Interaction-answer races | Verified | `integration/interaction-race.test.ts`; `host-agent/test/sessions.test.ts` |
| Dispatch dedupe after lost acknowledgement | Verified | `integration/dispatch-dedupe.test.ts`; `coordinator/test/dispatcher.test.ts` |
| Coordinator restart during execution | Verified | `integration/coordinator-restart.test.ts`, `coordinator-restart-checks.test.ts` |
| Host and process interruption | Verified | `integration/host-interruption.test.ts`; `pi-runtime/test/gate-interrupt.test.ts`; `host-agent/test/dispatch-recovery.test.ts` |
| Repo-local worktrees and external discovery | Verified | `integration/worktrees.test.ts`; `host-agent/test/git.test.ts` |
| Scheduler timezones, overlap, missed runs, dependencies | Verified | `coordinator/test/scheduler.test.ts` (fake clock, America/Denver across DST); `integration/scheduler.test.ts` |
| Takeover racing an automatic continuation | Verified | `integration/takeover-race.test.ts`, `takeover-launch.test.ts`; `coordinator/test/takeover.test.ts` |
| Adapter failure without approval bypass | Verified | `integration/adapter-failure.test.ts`; `adapter-sdk/test/registry.test.ts` |
| Enrollment expiry, reuse and revocation | Verified | `integration/enrollment.test.ts`; `coordinator/test/auth.test.ts` (including encoded-path auth bypass regressions) |
| Desktop coding view at 1440x900 and 1024x768 | Verified | `web/e2e/code-desktop.spec.ts` |
| Mobile coding view at 390x844 and 360x740 | Verified | `web/e2e/code-mobile.spec.ts` |
| Desktop board | Verified | `web/e2e/board-desktop.spec.ts` |
| Mobile board | Verified | `web/e2e/board-mobile.spec.ts` |
| Keyboard-only use | Verified | keyboard cases in `code-desktop.spec.ts` and `board-desktop.spec.ts` (keyboard drag, Move to menu) |
| No full-page horizontal overflow | Verified | `shared.spec.ts` at all four viewports |
| Mobile keyboard behaviour | Verified, emulated | `code-mobile.spec.ts` resizes `visualViewport`; a real on-screen keyboard was not used |
| Draft persistence | Verified | `shared.spec.ts` |
| Deep links | Verified | `shared.spec.ts` |
| Notification routing | Verified | `integration/notifications.test.ts` (real presence frames, stubbed sender) |
| OS notification delivery, tag replacement, clearing and click-through | **Unverified** | Needs a real browser and an iPhone Home Screen PWA with a subscription. The service worker code is in `packages/web/src/sw.ts`. Test with Settings > Notifications > Send test notification |

## Plugin compatibility

Recorded in `docs/compatibility.md`. Against pi-plugins `bbc6ce56` (all packages 0.1.2):

| Plugin | Status |
|---|---|
| ask-user-question (structured questions, multiselect without comma entry, Other) | Verified |
| tool-gate (approval card; Block blocks the call) | Verified |
| todo (panel) | Verified |
| bg (status panel) | Verified |
| subagents (linked read-only session) | Verified |

## Known limitations

These are upstream limits, disclosed in the product rather than hidden:

- `ctx.ui.custom()` returns `undefined` in Pi RPC mode. Switchyard detects it through its bridge extension and shows an unsupported-interaction card with the real alternatives: stop the run, or message the agent.
- Component widget factories are ignored in RPC mode; only string-array widgets reach clients.
- Pi writes a new session file only at the first assistant message. A session stopped before any reply cannot be resumed; it fails with `native_session_missing` instead of silently starting a new conversation.
- Subagent sessions are view-only.
- Web Push delivery, replacement and clearing are best effort per platform.

## 0.2.0 bootstrap and sign-in (2026-11-02)

Recorded against v0.2.0 (`ghcr.io/justmytwospence/switchyard:0.2.0`, linux/amd64 and linux/arm64), pi-plugins `ca7f9e22`.

| Item | Status | Evidence |
|---|---|---|
| No ownerless state: a fresh server mints nothing and shows only "isn't set up yet" | Verified | `coordinator/test/auth.test.ts`; `web/e2e/sign-in.spec.ts` |
| `switchyard init` / `pair` set the server up (admin token only) | Verified | `coordinator/test/auth.test.ts`; `cli/test/config.test.ts` |
| Passkey registration and sign-in on a new device | Verified, virtual authenticator | `coordinator/test/passkeys.test.ts`; `web/e2e/sign-in.spec.ts` (Chromium CDP authenticator) |
| OIDC sign-in with owner match, claims from userinfo, non-owner refused, PWA handoff | Verified, mock IdP | `coordinator/test/oidc.test.ts`; `web/e2e/sign-in.spec.ts` |
| Host self-enrollment with a shared secret; host waits without config | Verified | `integration/enrollment.test.ts`; `host-agent/test/wait-for-config.test.ts` |
| Per-project worktree folder | Verified | `host-agent/test/git.test.ts`; `integration/worktrees.test.ts` |
| Plugin adapters loaded from pi-plugins through the plugin tier | Verified | `host-agent/test/compat/*` (real Pi 1.4.0, real plugins) |
| Live deployment (container behind a reverse proxy, external OIDC provider): published image, owned at first start through the declared OIDC owner, host connected, Authelia accepts the `switchyard` client (authorize URL reaches Authelia's sign-in flow), OIDC discovery `ready` | Verified | live checks on the NUC |
| Real Authelia sign-in with 2FA on phone and Mac, passkey on a real device, iOS PWA handoff | **Unverified** | needs the owner's own sign-in |
