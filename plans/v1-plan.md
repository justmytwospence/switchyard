# Switchyard v1: self-hosted Pi metaharness, full spec in one build

## Summary

Build Switchyard (the spec's "Pi Workspace") from an empty `~/Projects/switchyard` as a pnpm TypeScript monorepo: a Fastify + SQLite coordinator, native host agents that own real `pi --mode rpc` processes, a React PWA with the four primary layouts plus Attention/Now/Automations/Settings, an Ink terminal client and a scriptable CLI. All ten spec phases ship in this one build, ordered so the protocol and the real-Pi compatibility gate land first. Independent packages are built by parallel workers against a fixed contract (the `protocol` package and this plan). The spec itself is saved verbatim as `docs/spec.md` (Appendix A) and stays binding; this plan adds the decisions the spec leaves open.

## Decisions

- **Name.** Product "Switchyard", packages `@switchyard/*`, binary `switchyard`. "Pi Workspace" was the spec's working title. Chosen by the user.
- **Repo.** Private `justmytwospence/switchyard` on GitHub, branch `main`, conventional commits. Chosen by the user.
- **Monorepo.** pnpm workspaces, chosen by the user. Node `>=24` (engines); the Docker image uses `node:26-bookworm-slim`. TypeScript project references (`tsc -b`), ESM, `module: NodeNext`. Rejected: running `.ts` directly with Node type stripping, which does not work for workspace packages linked under `node_modules`.
- **Pi integration.** One `pi --mode rpc` child process per live session, spoken to by our own JSONL client in `pi-runtime`. Rejected: the exported `RpcClient`, which cannot send `extension_ui_response`. Rejected: the in-process SDK, because a crashing extension would take down the host agent and the user's installed packages, settings and trust behave exactly as in the CLI only under the CLI.
- **Pi version.** Supported range `>=1.4.0 <1.6.0`. Tested on 1.4.0 (installed); `rpc-types.ts` is byte-identical in 1.4.0, 1.5.0 and main (blob `7fc71516`). The host agent runs `pi --version` at startup and refuses to start sessions outside the range, with "Pi <v> is outside the tested range >=1.4.0 <1.6.0".
- **Bridge extension.** Every managed Pi loads `-e <pi-runtime>/dist/bridge/switchyard-bridge.js`. It forwards `ui_prompt_start`/`ui_prompt_end` (kinds `select|confirm|input|editor|custom`) over a per-process Unix socket named by `SWITCHYARD_BRIDGE_SOCKET`. This is how we detect terminal-only `ctx.ui.custom()` calls, which RPC mode silently answers with `undefined`, and how we learn that Pi resolved a dialog itself (timeout or abort). Rejected: `pi.appendEntry`, which would pollute the user's session files.
- **Session identity.** The native handle is `{sessionId, sessionFile}` from `get_state`. New sessions start with `--session-id <uuid>` in the default session directory, so the owner's own `pi --session` can open them later. Resume is always `--session <sessionFile>`. If the file is missing, resume fails with `native_session_missing`; it never falls back to a fresh session.
- **Adapters run in the host agent.** The host has the installed plugins and local state, and is trusted. Their output (portable UI trees, panels, attention) is persisted in the host outbox and cached by the coordinator, so all clients see one server-authoritative state. Rejected: running adapters in the coordinator, which has no access to plugin installs and would have to receive code from hosts.
- **Interaction claiming is content-based.** RPC requests do not say which extension sent them. Adapters are consulted in precedence order (project, owner, plugin-provided, bundled) and claim by matching the request. Unclaimed requests get the generic renderer.
- **Persistence.** `node:sqlite` (`DatabaseSync`) in WAL mode, verified on Node 26.13 with SQLite 3.54.1. Rejected: `better-sqlite3`, which needs native builds in Docker and on every host.
- **Transport.** REST (JSON) for every mutation and query. WebSockets carry live events, presence and the host link: `/ws/client` for clients, `/ws/host` for hosts, which always connect outbound. Rejected: GraphQL and tRPC, extra layers with no benefit for a single owner.
- **Validation.** zod v4 schemas in `protocol` are the single source of types; every REST body, WS frame, host command and receipt is parsed at the boundary.
- **Streaming deltas are ephemeral.** Text, thinking and tool-argument deltas are fanned out live but not persisted or sequenced. Durable events are written at `message_end`, `tool_execution_end` and similar points. A reconnecting client gets durable events plus the current partial message in its snapshot.
- **Event ordering.** The coordinator assigns one global integer `seq`. Hosts assign `hostSeq` per host. Timestamps are display-only.
- **Continuation completion.** The run prompt asks the agent to end its final message with `SWITCHYARD: DONE`, `SWITCHYARD: BLOCKED <reason>` or (watch mode) `SWITCHYARD: NO_CHANGE`. The marker only ends continuation. Acceptance still needs the configured checks and/or human review. Rejected: an auditor model, because the spec says an agent or auditor claim is not proof, and it adds a provider dependency.
- **Acceptance checks.** Checks are owner-configured shell commands per project or task, run by the host in the workspace through `spawn("/bin/sh", ["-c", cmd])`. They are owner config, never task content.
- **Web stack.** React 19, Vite, React Router 7 (library mode), Zustand, Tailwind CSS v4 (`@tailwindcss/vite`), lucide-react icons, react-markdown with remark-gfm, `vite-plugin-pwa` (injectManifest). Rejected: a component framework (MUI and similar), whose density and theming fight the binding layout rules.
- **Terminal UI.** Ink 6. Rejected: blessed, which is unmaintained.
- **Remaining libraries.** commander for the CLI; croner for timezone-aware cron; web-push for VAPID; qrcode for SVG and terminal QR; pino for logs; ulid for sortable IDs; `@fastify/websocket`, `@fastify/static` and `@fastify/cookie`.
- **Standalone mode.** `switchyard up` runs the coordinator and a local host agent in one Node process. The host still connects over loopback `ws://127.0.0.1:<port>/ws/host` with the same protocol and enrollment, done automatically.
- **Authentication.**
  - Browsers: an HttpOnly `sy_device` cookie, `SameSite=Strict`, `Secure` when the public URL is https.
  - Terminal and CLI: `Authorization: Bearer`.
  - Browser mutations must send `X-Switchyard-Request: 1` and an `Origin` in the trusted list.
  - Local admin actions use `admin.token` (mode 0600) in the data directory.
- **Default port.** 7400, listening on `0.0.0.0:7400` by default.
- **Real-Pi tests.** Tests use the installed `pi` (`SWITCHYARD_PI_BIN` overrides) with `PI_CODING_AGENT_DIR=<tmp>`. The temp `models.json` points provider `mock` at a scripted OpenAI-compatible SSE server in `test-fixtures`. Real Pi, real RPC, deterministic model, no network, no cost.
- **Plugin compatibility tests.** They load real packages from `SWITCHYARD_PI_PLUGINS_DIR` (default `~/Projects/pi-plugins`). If that directory is missing, they skip with a reason, and the acceptance report marks them unverified.

## Architecture

```
 phone PWA / desktop web / Ink terminal / CLI
          | REST + /ws/client (device credential)
   +------v-------------------------------------------+
   | coordinator (Fastify, SQLite WAL)                |
   | identities, projects, tasks, runs, scheduler,    |
   | dispatcher, attention, presence, push, event log |
   +------^-------------------------------------------+
          | /ws/host (outbound from host; commands + receipts; events + acks)
   +------+-------------------------------------------+
   | host-agent (native, runs as the OS user)         |
   | SQLite outbox/receipts/dispatches/interactions,  |
   | git/worktrees, adapters, session supervisor      |
   +------+-------------------------------------------+
          | stdio JSONL (pi --mode rpc) + bridge socket
        pi processes (one per live session)
```

**Authority:**

| Area | Owner |
|---|---|
| Tasks, automations and dispatch decisions | Coordinator |
| Processes, interactions, filesystem and git truth | Host |
| Native history (session JSONL) | Pi |
| Transcript items for presentation | Coordinator caches them in `session_items` |

## Repository layout and tooling

```
switchyard/
  package.json            # private root; scripts below; packageManager pnpm@12
  pnpm-workspace.yaml     # packages/*
  tsconfig.base.json      # strict, ES2023, NodeNext, declaration, composite
  tsconfig.json           # references to every TS package except web
  vitest.workspace.ts     # projects: packages/*/vitest.config.ts
  playwright.config.ts    # web e2e, projects for the 4 viewports
  biome.json              # lint + format (Biome), 2-space, 100 cols
  .github/workflows/ci.yml# pnpm i, build, lint, unit tests (real-Pi tests skipped in CI: no pi)
  docs/                   # spec.md, architecture.md, protocol.md, adapters.md, deployment.md,
                          # operations.md, compatibility.md, sources.md, acceptance-report.md
  deploy/                 # compose.yaml, traefik.example.yaml, launchd/, systemd/
  Dockerfile              # coordinator image
  packages/
    protocol/ pi-runtime/ adapter-sdk/ adapter-examples/ host-agent/
    coordinator/ web/ terminal/ cli/ test-fixtures/
```

**Root scripts:**

| Script | Command |
|---|---|
| `build` | `pnpm -r --filter=!@switchyard/web exec tsc -b && pnpm --filter @switchyard/web build` |
| `test` | `vitest run` |
| `test:e2e` | `playwright test` |
| `lint` | `biome check .` |
| `dev` | runs coordinator standalone (`tsx packages/cli/src/main.ts up --dev`) and `vite` for web concurrently via `concurrently` |

Each package has `src/`, `test/`, `package.json` (`"type":"module"`, `exports` to `dist`), and a `tsconfig.json` with `composite: true` and references.

## Protocol (`packages/protocol`)

This package is the contract every other package builds on. Write it first, completely, by hand. Everything is a zod schema plus its exported inferred type.

### `src/ids.ts`

- `newId(prefix: IdPrefix): string` returns `${prefix}_${ulid()}`.
- Prefixes: `prj chk wsp ses tsk run aut occ int att dev hst enr cmd evt prf itm`.

### `src/entities.ts`

Field lists and enums. All timestamps are ISO strings.

- **`Host`:**
  - `id`, `name`, `platform: "darwin"|"linux"`, `agentVersion`, `piVersion|null`.
  - `piCompatible: boolean`.
  - `capabilities: RuntimeCapabilities`.
  - `connectivity: "connected"|"reconnecting"|"unreachable"`.
  - `lastSeenAt`, `revokedAt|null`.
- **`RuntimeCapabilities`:** a boolean map with keys `prompt`, `steer`, `followUp`, `abort`, `resume`, `rename`, `importInactive`, `extensionDialogs`, `customUi` (always false), `widgetsText`, `widgetsComponent` (always false), `tokenAccounting`, `costAccounting`. It also carries `unsupported: {capability, reason}[]`.
- **`Project`:**
  - `id`, `name`, `repoIdentity` (the normalized `git remote get-url origin`, or `local:<root-commit-sha>` without a remote).
  - `defaultProfileId|null`, `defaultHostId|null`.
  - `maxConcurrentRuns` (default 1), `automationEnabled` (default true).
  - `setupCommand|null`, `checks: string[]`.
  - `workspaceSharing: "single_writer"|"shared"`.
- **`Checkout`:** `id`, `projectId`, `hostId`, `path` (absolute clone root), `commonDir` (absolute `git rev-parse --git-common-dir`).
- **`Workspace`:**
  - `id`, `checkoutId`, `projectId`, `hostId`, `path`, `branch|null`, `baseBranch|null`.
  - `provenance: "managed"|"discovered"|"main"`.
  - `git: {dirty, changedFiles, ahead, behind, unmerged: boolean}`.
  - `setup: {state: "none"|"running"|"succeeded"|"failed", log: string}`.
  - `archivedAt|null`.
- **`Profile`:**
  - `id`, `name`, `provider|null`, `model|null`.
  - `thinking: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|null`.
  - `projectTrust: "ask"|"approve"|"ignore"`, which maps to no flag, `--approve` or `--no-approve`.
  - `extraArgs: string[]`, validated: each must start with `--` and must not be `--mode`, `--session*`, `--fork`, `--no-session` or `-e`/`--extension` pointing at the bridge.
- **`Session`:**
  - `id`, `title`, `hostId`, `workspaceId`, `projectId`.
  - `nativeHandle: {sessionId, sessionFile}|null`.
  - `profileSnapshot: Profile`.
  - `runtime: "starting"|"idle"|"running"|"waiting_input"|"interrupted"|"failed"|"stopped"`.
  - `connectivity` (derived from the host).
  - `runId|null`, `taskId|null`.
  - `provenance: "created"|"imported"|"subagent"`, `readOnly: boolean` (true for subagent views).
  - `lastActivityAt`, `archivedAt|null`, `queue: {steering: string[], followUp: string[]}`.
- **`Task`:**
  - `id`, `projectId`, `title`, `objective`, `acceptanceCriteria: string[]`, `dependencies: string[]`.
  - `priority: 0|1|2|3` (Urgent, High, Normal, Low; default 2), `position: number`.
  - `state: "backlog"|"ready"|"in_progress"|"review"|"done"|"canceled"`.
  - `blocked: {reason: string}|null`, `notBefore|null`.
  - `policy: TaskPolicy`.
  - `origin: {kind: "manual"}|{kind: "automation", automationId, occurrenceId, routine: boolean}`.
  - `groupingKey|null`, `currentRunId|null`, `sessionId|null`.
  - `review: {feedback: string[], changesRequested: boolean}`.
  - `hiddenFromBoard: boolean`, `createdAt`, `updatedAt`.
- **`TaskPolicy`:**
  - `hostId|null`, `profileId|null`.
  - `workspace: {mode: "new_worktree", branch: string|null, base: string|null} | {mode: "existing", workspaceId}`.
  - `continuation: {enabled: false} | {enabled: true, objective: string, maxContinuations: 1..50, maxElapsedMinutes: 1..1440, maxTokens: number|null, maxCostUsd: number|null}`.
  - `completion: {checks: string[]|null (null = project checks), requireHumanReview: boolean (default true)}`.
- **`Run`:**
  - `id`, `taskId`, `sessionId|null`, `dispatchKey` (equal to the run id), `attempt`.
  - `state: "queued"|"dispatching"|"uncertain"|"running"|"waiting_input"|"checking"|"succeeded"|"failed"|"interrupted"|"canceled"`.
  - `controlMode: "automation"|"human"`, `controlRevision: number`.
  - `continuationsUsed`, `infraRetries`, `startedAt|null`, `endedAt|null`.
  - `outcome: {kind: "review"|"failed"|"blocked"|"no_change"|"canceled", summary}|null`.
  - `limits` (a snapshot of the continuation policy).
  - `usage: {tokens: number|null, costUsd: number|null, accounting: "available"|"unavailable", note}`.
  - `checks: {command, exitCode, outputTail}[]`.
- **`Automation`:**
  - `id`, `name`, `enabled`, `projectId`, `trigger`.
  - `trigger` is one of:
    - `{kind: "manual"}`
    - `{kind: "once", at}`
    - `{kind: "cron", expr, timezone}`
    - `{kind: "webhook"}`
    - `{kind: "dependency", taskId}`
  - `filters: {path: string, equals: string}[]`.
  - `template: {title, objective, acceptanceCriteria: string[], priority}`.
  - `hostId|null`, `profileId|null`, `mode: "fresh"|"continue"|"watch"`, `groupingKey: string|null` (a template).
  - `overlap: "skip"|"queue_one"|"append"`, `missed: "skip"|"run_once"`.
  - `continuation`, `completion` (same shapes as `TaskPolicy`).
  - `nextAt|null`, `lastOutcome|null`, `failureCount`, `webhookTokenSet: boolean`.
- **`Occurrence`:**
  - `id`, `automationId`, `key` (unique per automation), `scheduledFor|null`.
  - `state: "fired"|"skipped_overlap"|"skipped_missed"|"queued"|"appended"|"failed"|"filtered"`.
  - `taskId|null`, `reason|null`, `createdAt`.
- **`Interaction`:**
  - `id`, `sessionId`, `revision: number`.
  - `source: {kind: "extension_ui", method: "select"|"confirm"|"input"|"editor", piRequestIds: string[]} | {kind: "unsupported_custom", title: string|null}`.
  - `adapterId|null`, `title`, `presentation: UINode`.
  - `state: "pending"|"resolved"|"expired"|"cancelled"|"unsupported"`.
  - `resolution: {by: deviceId|"host"|"pi", summary: string, at}|null`.
  - `createdAt`.
- **`AttentionItem`:**
  - `id`, `sessionId|null`, `taskId|null`, `projectId`.
  - `reason: "needs_input"|"failed"|"ready_for_review"|"unsupported_interaction"|"host_unreachable"`.
  - `severity: "info"|"warning"|"critical"`, `summary`, `interactionId|null`, `deepLink`.
  - `acknowledgedAt|null`, `resolvedAt|null`, `createdAt`.
- **`Device`:**
  - `id`, `name`, `kind: "browser"|"pwa"|"terminal"|"cli"`, `createdAt`, `lastSeenAt`, `revokedAt|null`.
  - `push: {subscribed: boolean, permission: "granted"|"denied"|"default"|"unknown"}`.
  - `preferredMobile: boolean`.
- **`TranscriptItem`:**
  - `id` (item id), `sessionId`, `order: number` (host-assigned, monotonic per session).
  - `kind: "user"|"assistant"|"thinking"|"tool"|"notice"|"interaction"|"subagent"|"system"`.
  - `data`, by kind:
    - user and assistant: `{text, images?: number}`
    - tool: `{toolCallId, name, status: "running"|"ok"|"error", args, summary, output, startedAt, durationMs|null, card: UINode|null, adapterId|null}`
    - notice: `{level, text}`
    - interaction: `{interactionId}`
    - subagent: `{runId, label, status, sessionFile|null, linkedSessionId|null}`
    - system: `{text}`

### `src/ui.ts`: portable components

`UINode` is a recursive zod union discriminated on `t`. Its variants:

| `t` | Fields |
|---|---|
| `text` | `text`, `tone?: "default"\|"muted"\|"success"\|"warning"\|"danger"` |
| `markdown` | `text` |
| `code` | `text`, `lang?` |
| `diff` | `patch` |
| `list` | `items: UINode[]`, `ordered?` |
| `table` | `columns: string[]`, `rows: string[][]` |
| `section` | `title?`, `collapsible?`, `children: UINode[]` |
| `tabs` | `tabs: {id, label, children: UINode[]}[]` |
| `progress` | `label`, `value?: 0..1`, `status?: "running"\|"ok"\|"error"` |
| `ref` | `ref: {kind: "file", path} \| {kind: "session", sessionId} \| {kind: "task", taskId} \| {kind: "native_session", hostId, sessionFile}`, `label` |
| `form` | `formId`, `fields: Field[]`, `submitLabel`, `cancelLabel?` |
| `confirm` | `message`, `confirmLabel`, `cancelLabel`, `destructive?` |
| `actions` | `actions: {id, label, tone?: "default"\|"primary"\|"danger"}[]` |

`Field` is one of:

- `{kind: "select", name, label, options: {value, label, description?, preview?}[], allowOther?: {label, placeholder?}}`
- `{kind: "multiselect", name, label, options, allowOther?, min?, max?}`
- `{kind: "text", name, label, placeholder?, multiline?, prefill?}`

Every field kind also takes an optional `showIf: {field: string, values: string[]}`. Renderers show the field only when the named earlier field's value (or any selected value, for a multiselect) is in `values`. Hidden fields are omitted from the submitted values.

Bound every tree: depth 12 and 2,000 nodes, enforced by `validateUINode()`, which throws `ui_tree_too_large`.

An interaction response is one of:

- `{kind: "form", values: Record<string, string | string[] | {other: string}>}`
- `{kind: "confirm", confirmed: boolean}`
- `{kind: "action", actionId}`
- `{kind: "cancel"}`

### `src/events.ts`

`EventEnvelope {seq: number, id: string, type, at, hostId?, sessionId?, taskId?, projectId?, data}`.

Durable `type` values, whose `data` is the full new entity unless stated:

- `host.updated`, `project.updated`, `checkout.updated`
- `workspace.updated`, `workspace.removed {id}`
- `profile.updated`
- `session.updated`
- `transcript.item` (an upserted `TranscriptItem`)
- `interaction.updated`
- `panel.updated {sessionId, adapterId, slot, node: UINode|null}`
- `diagnostic {sessionId|null, adapterId|null, level, message}`
- `task.updated`, `task.deleted {id}`, `run.updated`
- `automation.updated`, `automation.deleted {id}`, `occurrence.created`
- `attention.updated`, `device.updated`

Ephemeral (no `seq`): `stream {sessionId, itemId, kind: "text"|"thinking"|"tool_args"|"tool_output", delta}` and `presence.changed`.

### `src/host-wire.ts`: host link

**Host to coordinator:**

- `hello {hostId, credential, agentVersion, piVersion, platform, capabilities, lastAckedHostSeq}`
- `event {hostSeq, event: HostEvent}`, where `HostEvent` has the same shape as `EventEnvelope` minus `seq`, plus `eventId`.
- `stream {...}` (ephemeral)
- `receipt {commandId, ok: true, result} | {commandId, ok: false, error: {code, message}}`

**Coordinator to host:**

- `welcome {coordinatorVersion, ackedHostSeq}`
- `ack {hostSeq}` (cumulative)
- `command {commandId, command: HostCommand}`

`HostCommand` is a discriminated union on `type`:

**Session commands:**

- `session.start {sessionId, title, workspacePath, profile, nativeHandle|null, initialPrompt|null, dispatchKey|null, controlRevision, origin}`
- `session.prompt {sessionId, text, images: {mimeType, data}[], mode: "prompt"|"steer"|"followUp", origin: "human"|"automation", controlRevision}`
- `session.abort {sessionId, clearQueue}`
- `session.stop {sessionId}`
- `session.answer {sessionId, interactionId, revision, response, deviceId}`
- `session.adapterAction {sessionId, adapterId, actionId, payload}`
- `session.setControl {sessionId, controlRevision, mode}`
- `session.rename {sessionId, title}`
- `session.importable {}`
- `session.readNative {sessionFile}`, which returns transcript items for a read-only view
- `session.snapshot {sessionId}`, which returns the current partial stream and pending interactions

**Checkout and workspace commands:**

- `checkout.inspect {path}`, which returns `{root, commonDir, repoIdentity, defaultBranch}` or the error `not_a_git_repo`
- `workspace.discover {checkoutPath}`
- `workspace.create {checkoutPath, branch, base, setupCommand|null}`
- `workspace.status {path}`
- `workspace.remove {path, checkoutPath, force: {dirty: boolean, unmerged: boolean}}`
- `workspace.diff {path, file|null}`
- `workspace.files {path, dir}`
- `workspace.readFile {path, file}`, capped at 1 MB; returns `too_large` beyond it

**Dispatch and check commands:**

- `dispatch.start {dispatchKey, runId, taskId, sessionId, title, workspace: {path} | {createFrom: {checkoutPath, branch, base, setupCommand}}, profile, prompt, controlRevision}`
- `dispatch.reconcile {dispatchKey}`, which returns `{known: false} | {known: true, sessionId, runtime, workspacePath}`
- `checks.run {sessionId, path, commands}`, which returns `{results: {command, exitCode, outputTail}[]}` with output tails of 8 KB

### `src/client-wire.ts`

**Client to server:**

- `hello {cursor: number|null, deviceId}`
- `presence {foreground: boolean, interactedAt: string|null, viewing: {sessionId}|null}`, sent every 20 s and on change
- `ping`

**Server to client:**

- `ready {seq, mode: "replay"} + events` or `snapshot {seq, state: SyncState}`
- `event`, `stream`, `pong`
- `force_logout {reason}`

`SyncState` holds every non-archived host, project, checkout, workspace, profile, session, task, run, automation, attention item and pending interaction, plus `{dispatchPaused}`. Transcripts are not included; clients load them per session over REST.

### `src/api.ts`

Request and response schemas for every REST route listed under coordinator, plus `ApiError {error: {code, message, details?}}`. Error codes are a `const` enum shared by all packages:

- `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `conflict`, `already_answered`, `stale_control`
- `host_unreachable`, `pi_incompatible`, `native_session_missing`
- `invalid_transition`, `dependency_cycle`
- `workspace_dirty`, `workspace_unmerged`, `workspace_active_sessions`
- `branch_invalid`, `path_collision`, `not_a_git_repo`, `repo_mismatch`
- `enrollment_expired`, `enrollment_used`, `device_revoked`
- `unsupported_capability`, `internal`

`src/index.ts` re-exports all of the above, plus `PROTOCOL_VERSION = 1` and `branchSlug(branch) = branch.replaceAll("/", "-")`.

## Changes by package

### `packages/test-fixtures`

- **`src/mock-model-server.ts`:** `startMockModel(script: MockScript): Promise<{url, close, requests}>`.
  - It is an OpenAI Chat Completions server on `127.0.0.1:0`.
  - `POST /v1/chat/completions` streams SSE chunks: text deltas, `tool_calls` deltas, finish reason and usage.
  - `MockScript` is an ordered list of rules `{when: (req) => boolean, reply: {text?: string, toolCalls?: {name, arguments}[], delayMs?}}`.
  - Matching uses the last message's role and content. The default rule replies `"ok"`.
  - It records every request.
- **`src/pi-env.ts`:** `makePiEnv({mockUrl, extensions?: string[]}): {agentDir, env, args}`.
  - It writes `<tmp>/agent/models.json` with provider `mock` (`api: "openai-completions"`, `apiKey: "mock"`, model `mock-1`, `contextWindow` 128000, `maxTokens` 4096).
  - It writes `settings.json` with `{"defaultProvider":"mock","defaultModel":"mock-1"}`.
  - It returns env `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, and args `["--provider","mock","--model","mock-1"]`.
- **`src/fixture-extension.ts`** (loaded with `-e`) registers tools:
  - `fixture_select`: `ctx.ui.select("Pick a fruit", ["Apple","Banana"])`, returning the value.
  - `fixture_confirm`.
  - `fixture_input`.
  - `fixture_custom`: calls `ctx.ui.custom(...)` and returns `"custom returned " + String(result)`.
  - `fixture_slow`: waits 30 s, honouring the signal.
  - `fixture_status`: `setStatus` and `setWidget`.
- **`src/git-repo.ts`:** `makeRepo({remote?}): {path, cleanup}`, a temporary git repo with an initial commit on `main`.
- **`src/pi-bin.ts`:** `piBin()` returns `process.env.SWITCHYARD_PI_BIN ?? "pi"`. `requirePi()` throws a clear error when `pi --version` fails, so real-Pi tests fail rather than pass silently. CI sets `SWITCHYARD_SKIP_REAL_PI=1`, which skips them with a reason.

### `packages/pi-runtime`

- **`src/jsonl.ts`:** `JsonlReader` splits a byte stream on LF only, strips one trailing CR, and must not split on U+2028/U+2029. `writeJsonl(stream, obj)` honours backpressure.
- **`src/rpc-process.ts`:** `class PiRpcProcess`.
  - `static start({piBin, cwd, args, env}): Promise<PiRpcProcess>` spawns `pi --mode rpc ...args -e <bridge>`.
  - `request<T>(cmd: object, timeoutMs = 60000): Promise<T>` correlates by `id` and rejects with the Pi error string on `success:false`.
  - `respondUi(id, body)` writes an `extension_ui_response`.
  - `on("event" | "ui_request" | "bridge" | "exit" | "stderr")`.
  - `close()` ends stdin, waits 10 s, then SIGTERM, then SIGKILL after 3 s.
  - Stdout is read continuously, never paused.
  - The rest of the bridge socket is a Unix server at `<runtimeDir>/bridge-<uuid>.sock`, listening before spawn.
- **`src/bridge/switchyard-bridge.ts`** is compiled to `dist/bridge/switchyard-bridge.js`.
  - It is a default-export extension factory.
  - On `ui_prompt_start` and `ui_prompt_end` it writes `{type, kind, title}` lines to the socket in `SWITCHYARD_BRIDGE_SOCKET`.
  - It is a no-op when the variable is unset.
  - It never throws: a socket error disables forwarding.
- **`src/capabilities.ts`:**
  - `detectPi(piBin): Promise<{version, compatible, capabilities}>`.
  - `SUPPORTED_RANGE = ">=1.4.0 <1.6.0"`, checked with `semver`.
  - Capabilities: steer, followUp, abort, resume, rename, importInactive and extensionDialogs are all true. `customUi:false` gives the reason "ctx.ui.custom() returns undefined in RPC mode". `widgetsComponent:false` gives "component widget factories are ignored in RPC mode". `tokenAccounting:true` comes from `get_session_stats.tokens`; `costAccounting:true` from `.cost`.
- **`src/session-runtime.ts`:** `class ManagedSession` (`EventEmitter`) wraps one `PiRpcProcess`.
  - **`start(opts)`:**
    - Args: `--session-id <uuid>` when `nativeHandle` is null, otherwise `--session <file>`. Then `--name <title>` and the profile flags (`--provider`, `--model`, `--thinking`, the trust flag, `extraArgs`). Never pass `--offline` in production; tests set `PI_OFFLINE=1` through the environment instead.
    - After spawn it calls `get_state` and emits `native` with `{sessionId, sessionFile}`.
    - If `--session <file>` was used and the file no longer exists, it throws `native_session_missing` before spawning.
  - **Event mapping.** It holds the transcript item builder:
    - `message_start`/`message_end` with role `user` makes a user item.
    - Assistant messages make assistant items; thinking blocks get a separate thinking item.
    - Custom messages make a notice item, or are passed to adapters.
    - `tool_execution_*` makes tool items, with summary = adapter card or a generic one-liner (tool name plus the first string arg, truncated to 120 chars).
    - The item `order` counter is persisted by the host.
    - `queue_update` updates `session.queue`.
    - `agent_start` sets runtime `running`; `agent_settled` sets `idle` and emits `settled {aborted, lastAssistantText}`.
    - `auto_retry_*` and `compaction_*` produce notice items.
    - `extension_error` produces a diagnostic.
  - **Runtime state.**
    - `waiting_input` while any interaction is pending.
    - Unexpected exit (exit code ≠ 0, or exit not requested) gives `interrupted`, keeping `nativeHandle`.
    - Spawn or `get_state` failure gives `failed`.
    - A requested close gives `stopped`.
  - **`prompt(text, images, mode)`:**
    - `mode "prompt"` sends `prompt`; while streaming this is rejected with `invalid_request` and the message "Session is running: choose Steer or Queue follow-up".
    - `"steer"` sends `steer`; `"followUp"` sends `follow_up`.
    - It returns the disposition.
  - **`abort(clearQueue)`:** `clear_queue` first when requested, then `abort`.
  - **`rename(title)`** calls `set_session_name`.
  - **`stats()`** calls `get_session_stats`.
  - **`history()`** maps `get_messages` to items, for attach and resume.
- **`src/importable.ts`:**
  - `listImportable(sessionsRoot = ~/.pi/agent/sessions)` reads the first line (header) of each `*.jsonl`, plus the last `session_info` name.
  - It returns `{sessionFile, sessionId, cwd, name|null, mtime, inactive: mtime older than 120 s}`.
  - `readNativeTranscript(file)` parses entries with `parseSessionEntries` from `@earendil-works/pi-coding-agent` (a peer dependency `>=1.4.0 <1.6.0`; resolve from the installed pi via `createRequire(realpath(which pi))` and fall back to our own minimal JSONL parse of `message` entries if the import fails).

**pi-runtime tests**, real Pi with the mock model; each file uses `requirePi()`:

- `test/jsonl.test.ts`: U+2028 inside strings is kept; CRLF is stripped; split chunks reassemble.
- `test/gate-prompt.test.ts`: prompt then `agent_settled`; user and assistant items emitted; `sessionFile` exists on disk.
- `test/gate-question.test.ts`: the mock calls `fixture_select`; a `ui_request` select arrives; we answer `Banana`; the tool result contains `Banana`; the bridge emitted `ui_prompt_start` and `ui_prompt_end` for kind `select`.
- `test/gate-abort.test.ts`: `fixture_slow`, then abort within 2 s; `agent_settled {aborted:true}`; runtime `idle`.
- `test/gate-resume.test.ts`:
  - Start, prompt, close, restart with `--session <file>`.
  - `get_state.sessionId` is unchanged and `history()` contains the earlier prompt.
  - A deleted file gives `native_session_missing`.
- `test/gate-interrupt.test.ts`: SIGKILL the child; runtime `interrupted`, `nativeHandle` kept.
- `test/gate-custom.test.ts`: `fixture_custom`; the bridge reports kind `custom`; the tool result says `custom returned undefined`.
- `test/gate-reconnect.test.ts`: two event listeners (simulating terminal and web via the host fan-out) receive the same sequence.

The results are written to `docs/compatibility.md` by the implementer, with the Pi version and date.

### `packages/adapter-sdk`

- **`src/manifest.ts`:** zod `AdapterManifest`:
  - `{id, version, target: {extension, versionRange, testedVersions: string[]}, protocolVersion: 1, server: string, webRenderer: string|null, capabilities: ("toolCards"|"interactions"|"panels"|"commands"|"progress"|"subagents"|"attention"|"state")[]}`.
  - Loaded from `switchyard-adapter.json`.
- **`src/types.ts`:** `ServerAdapter`. All hooks are optional and may be async.

  ```ts
  interface ServerAdapter {
    toolCard?(tool: {name; args; result?; isError?; details?}, ctx): UINode | undefined;
    claimInteraction?(req: PiUiRequest, ctx): Claim | undefined;   // PiUiRequest = select|confirm|input|editor payload
    onToolStart?(e, ctx); onToolEnd?(e, ctx); onEntry?(entry, ctx); onCustomMessage?(m, ctx);
    onStatus?(key, text|undefined, ctx); onWidget?(key, lines|undefined, ctx);
    onAction?(actionId, payload, ctx);
  }
  type Claim = { title: string; presentation: UINode; toPiResponse(resp: InteractionResponse): PiUiResponse | {sequence: PiUiResponse[]} };
  ctx = { sessionId, state: {get<T>(k): T|undefined; set(k, v)}, setPanel(slot, node|null), attention(reason, summary), linkSubagent({runId,label,status,sessionFile}), queueAnswers(matcher, responses[]), log(level,msg) }
  ```

  `queueAnswers` lets a questionnaire adapter pre-answer the follow-up dialogs of the same tool call with values the user already gave. Queued answers expire when the owning tool call ends.

- **`src/registry.ts`:** `class AdapterRegistry`:
  - `load({projectRoot|null, ownerDir = ~/.config/switchyard/adapters, pluginPackageDirs: string[], bundled: LoadedAdapter[]})`.
  - It orders adapters project > owner > plugin > bundled. Plugin adapters are found by reading `package.json` `switchyard.adapter` from each Pi package dir listed in `<PI_CODING_AGENT_DIR or ~/.pi/agent>/settings.json` `packages` (git sources resolve under `~/.pi/agent/git/...`; skip unresolvable ones with a diagnostic).
  - `call(hook, ...)` wraps every call in try/catch with a 2 s timeout. On error it disables that adapter for the session, emits a `diagnostic`, and returns undefined, so the caller falls back to generic. It never auto-answers.
  - `claim(req)` returns the first non-undefined claim, or a generic claim.
- **`src/generic.ts`:** `genericClaim(req)` maps each request to a claim:

| Request | Presentation | Pi response |
|---|---|---|
| `select` | a form with one select (options as given) | `{value}` |
| `confirm` | a `confirm` node | `{confirmed}` |
| `input` | a text field | `{value}` |
| `editor` | a multiline text field with `prefill` | `{value}` |

  Cancel maps to `{cancelled:true}`. It also has `genericToolCard(tool)` and `genericStatusPanel(statuses: Map)` (a table of key/text).

- **`src/web-bridge.ts`:** the message types for custom web renderers:
  - parent to frame: `{type: "render", node, state}`
  - frame to parent: `{type: "action", actionId, payload}` and `{type: "resize", height}`

### `packages/adapter-examples` (bundled adapters at plugin tier; each folder has `switchyard-adapter.json` + `server.ts`)

- **`ask-user-question`** (target `@justmytwospence/pi-ask-user-question`, tested `0.1.2`):
  - `onToolStart` for `ask_user_question` stores args (the questions schema) under the `toolCallId`.
  - `claimInteraction` claims a select whose title starts with `[<header of question 1>]`. It presents one form with one field per question:
    - `select`, or `multiselect` when `multiSelect`.
    - Options carry `preview`.
    - `allowOther: {label: "Type something."}`.
    - `showIf` maps to the `Field.showIf: {field, values}` property (defined in protocol `ui.ts`), so the web and terminal forms hide fields whose condition is unmet.
  - `toPiResponse` builds the sequence for the RPC dialogs in Pi's order (`rpc.ts` behavior):
    - Single select becomes `"<n>. <label> - <description>"` exactly as the request options list (matched by the `^n\.` prefix of the actual options), or the last option, then the queued `input` value for Other.
    - Multi-select becomes the `input` value `"1,3"`, the 1-based indices.
    - Skipped `showIf` questions produce no dialog.
    - The first response answers the current request. The rest go to `queueAnswers` for the next dialogs of the same tool call, matched by method in order.
  - Cancel sends `{cancelled:true}`.
- **`tool-gate`** (target `@justmytwospence/pi-tool-gate`, `0.1.2`):
  - It claims a select whose title starts with `"Allow this call?"`.
  - It parses lines `Action:`, `Target:`, `Held:`, `Agent:` and `Rule:`/`Folder:`/`Project saves:` into a table, with the remaining text as markdown.
  - Actions are one per option, with `"Block"` and `"Block with a message"` getting tone `danger` and `"Allow once"` getting `primary`.
  - `toPiResponse` returns `{value: <option string>}`.
  - The follow-up `input`/`editor` dialogs are left to generic.
- **`plan-mode`** (`@justmytwospence/pi-plan-mode`):
  - `onCustomMessage` with `customType === "plan-mode-plan"` calls `setPanel("plan", markdown(content))`.
  - `onStatus` for keys `workflow-mode`, `plan` and `plan-exec` updates the `"plan-status"` panel table.
- **`subagents`** (`@justmytwospence/pi-subagents`):
  - `onEntry` for `customType === "subagents:run"`, and `onToolEnd` for `subagent` (`details.runs`), call `linkSubagent` per run, keeping the latest by id.
  - A subagent item links to a read-only session view (`session.readNative` on its `sessionFile`). The UI states "Subagent: view only. Live control is not supported."
- **`todo`** (`@justmytwospence/pi-todo`): `onToolEnd` for `todo` reads `details.tasks` into a `"todo"` panel list of status and title.
- **`bg`** (`@justmytwospence/pi-bg`): `onStatus` for key `bg` updates the `"bg"` panel as progress or text. It ships `web/bg-renderer.html` as the custom web renderer example: a sandboxed frame drawing a compact task list from `state`.

### `packages/host-agent`

**`src/db/`** uses `node:sqlite`:

- `openHostDb(path)` with `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`.
- `migrate()` applies `migrations/NNN_*.sql` in order and records them in `schema_migrations`.
- `001_init.sql` creates these tables:
  - `meta(key, value)`
  - `outbox(host_seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE, json TEXT, created_at)`
  - `receipts(command_id PRIMARY KEY, json, created_at)`
  - `dispatches(dispatch_key PRIMARY KEY, run_id, session_id, state TEXT CHECK(state IN ('accepted','workspace_ready','started','failed')), error, updated_at)`
  - `sessions(id PRIMARY KEY, json)`, which holds the native handle, workspace path, profile, control revision, control mode and item order
  - `interactions(id PRIMARY KEY, session_id, revision, state, json)`
  - `adapter_state(session_id, adapter_id, key, json, PRIMARY KEY(...))`
  - `panels(session_id, adapter_id, slot, json, PRIMARY KEY(...))`

**`src/config.ts`:**

- `~/.config/switchyard/host.json` (mode 0600) holds `{coordinatorUrl, hostId, credential, name}`.
- The state dir is `~/.local/state/switchyard/` (macOS: `~/Library/Application Support/switchyard/`), holding `host.db`, `runtime/` (bridge sockets) and `logs/`.

**`src/link.ts`:** `class CoordinatorLink`.

- It keeps a WS to `<coordinatorUrl>/ws/host` with reconnect backoff 1 s, 2 s, 5 s, 10 s, capped at 30 s, with jitter.
- On connect it sends `hello`, then replays every outbox row with `host_seq > ackedHostSeq` in order.
- `emit(event)` inserts into the outbox (in the same transaction as the state change that caused it), then sends if connected.
- On `ack` it deletes rows `<= hostSeq` older than 24 h; it keeps 24 h for diagnostics.
- Commands go to `CommandRouter`.

**`src/commands.ts`:** `CommandRouter.handle(commandId, command)`.

- If `receipts` has the `commandId`, it resends the stored receipt.
- Otherwise it runs the handler through a per-session serial queue (keyed by `sessionId`, or `"host"` for others), stores the receipt, then sends it.
- Automation-origin `session.prompt` with `controlRevision < stored revision` returns error `stale_control`.

**`src/supervisor.ts`:** `class SessionSupervisor` maps `sessionId` to `ManagedSession` plus an adapter context.

- **Fan-out.** It maps runtime events to host events (`session.updated`, `transcript.item`, `interaction.updated`, `panel.updated`, `diagnostic`) and streams.
- **Pi `ui_request` dialogs.** It calls `registry.claim()`, then creates an Interaction (`revision 1`, `pending`) persisted before emitting.
  - Requests matched by an adapter's `queueAnswers` are answered immediately. They still create an Interaction recorded as resolved by `"host"` with summary `"Answered from your earlier form"`.
- **`answer(interactionId, revision, response, deviceId)`.** In one transaction it requires `state === "pending" && revision === row.revision`, otherwise it returns `{status: "already_answered", interaction}`. Then it maps the response through the claim, writes `extension_ui_response`(s), and marks it resolved.
- **Bridge `ui_prompt_end`.** If the interaction for that prompt is still pending, mark it `expired` with summary "Pi closed this question (timeout or abort)".
- **Bridge `ui_prompt_start` kind `custom`.** Create an Interaction with state `unsupported` and presentation:

  ```
  section("Terminal-only interface requested",
    [text("An extension opened a terminal-only dialog. In RPC mode Pi gave it no answer, so the extension continued without one."),
     actions(abort: "Stop the run", message: "Send a message to the agent")])
  ```

  It also raises the `unsupported_interaction` attention.
- **Fire-and-forget requests:**
  - `notify` becomes a notice item.
  - `setStatus` and `setWidget` (lines) go through adapter hooks, then the generic `"status"`/`widget:<key>` panels.
  - `setTitle` becomes `session.updated` subtitle.
  - `set_editor_text` becomes a `transcript.item` of kind `system` with `{text, suggestion: true}`. Clients offer "Use suggestion" and never overwrite a draft.
- **Restart behavior.** On host-agent restart, sessions whose recorded runtime was `running`, `idle` or `waiting_input` are marked `interrupted`. The process died with the agent, because children are spawned non-detached so they cannot outlive a crashed supervisor unmanaged. Each gets a notice "Host agent restarted; resume to continue". They are never auto-resumed or replayed.

**`src/git.ts`** (all via `execFile("git", [...])`, no shell):

- `inspectCheckout(path)` runs `rev-parse --show-toplevel` and `--git-common-dir` (made absolute), `remote get-url origin` (normalized: strip `.git`, `git@host:` to `https://host/`, lowercase host) and `symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`.
- `discover(checkoutPath)` parses `git worktree list --porcelain -z` into `{path, head, branch|null, bare, detached, locked, prunable}`.
  - Paths under `<root>/.worktrees/` are `managed`, the root is `main`, everything else is `discovered`.
- `validateBranch(name)` runs `git check-ref-format --branch`; failure gives `branch_invalid`.
- `createWorktree(root, branch, base)`:
  1. Compute `path = <root>/.worktrees/<branchSlug>`.
  2. Reject with `path_collision` if the path exists or the slug is already used by another branch's worktree.
  3. Ensure `.worktrees/` is ignored by appending to `<commonDir>/info/exclude` when missing.
  4. Run `worktree add -b <branch> <path> <base>`, or without `-b` when the branch already exists and is not checked out.
  5. Verify the new worktree's `--git-common-dir` equals the checkout's, otherwise `repo_mismatch`.
- `status(path)` uses `status --porcelain=v2 --branch -z` for dirty, changed count, ahead and behind. `unmerged` is true when `git cherry <base> HEAD` lists any `+` commits; the base comes from the stored workspace `baseBranch`, else the default branch.
- `diff(path, file)` is `git diff --no-color -M <base>...` plus the working tree, combined as `git diff --no-color <merge-base>` covering committed and uncommitted changes. The file list comes from `--numstat`. Untracked files are included via `git ls-files --others --exclude-standard`, rendered as added files.
- `removeWorktree(path, force)`:
  - Refuse with `workspace_active_sessions` when the supervisor has a live session there.
  - Refuse with `workspace_dirty` / `workspace_unmerged` unless the matching force flag is set.
  - Then `worktree remove [--force] <path>`. It never deletes the branch.
- `runSetup(path, cmd)` spawns `/bin/sh -c cmd` in the path and streams output into `workspace.updated` (`setup.log` capped at 64 KB, tail kept).

**`src/files.ts`:** `listDir` and `readFile`. Both resolve the realpath and refuse anything outside the workspace root (`forbidden`).

**`src/dispatch.ts`:** `handleDispatchStart(cmd)`.

1. If a `dispatches` row exists, return its stored outcome; the same session is never started twice.
2. Insert `accepted`.
3. Create the worktree if requested, then update to `workspace_ready`.
4. Start `ManagedSession` with the prompt as the initial `prompt` command, then update to `started` with the `sessionId`.
5. On failure, update to `failed` with the error and return it.

`reconcile(key)` reads the row.

**`src/checks.ts`:** runs commands sequentially with a timeout of 30 min each, capturing the 8 KB tail.

**`src/main.ts`:** `runHostAgent({configPath})` wires the DB, link, supervisor and registry. On SIGTERM it closes all Pi processes gracefully, marking them `stopped`.

### `packages/coordinator`

**`src/db/migrations/001_init.sql`** creates tables for every entity in `entities.ts`:

- JSON columns as TEXT, indexed scalar columns for lookups.
- `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, type, session_id, task_id, project_id, host_id, json, at)`
- `host_events_seen(host_id, event_id, PRIMARY KEY(...))`, for dedupe
- `session_items(session_id, item_id, ord, json, PRIMARY KEY(session_id, item_id))`
- `occurrences` with `UNIQUE(automation_id, key)`
- `runs` with `UNIQUE(dispatch_key)`
- `enrollments(id, kind 'device'|'host', token_hash, expires_at, used_at)`
- `devices` and `hosts` with `credential_hash` (sha256)
- `push_subscriptions(device_id, endpoint UNIQUE, json)`
- `presence(device_id PRIMARY KEY, foreground_until, interacted_at, viewing_session_id)`
- `notifications(session_id PRIMARY KEY, attention_id, sent_to_device, sent_at, tag)`
- `settings(key, value)`, which holds the VAPID keys, retention, quiet hours and the dispatch-paused flag

**`src/store.ts`:** the repository layer.

- Typed `get`/`list`/`upsert` per entity.
- `transaction(fn)`.
- `appendEvent(type, scope, data)` inserts into `events` inside the caller's transaction, then, after commit, publishes to `EventHub`. The hub fans out to client sockets filtered by nothing (single owner).
- Retention runs hourly: delete events older than `retentionDays` (default 30). `minRetainedSeq` is recorded.

**`src/auth.ts`:**

- Tokens are 32 random bytes, base64url; only sha256 is stored.
- `createEnrollment(kind, ttl)`: device 10 min, host 30 min; single use.
- `redeem(token)` checks expired (`enrollment_expired`), used (`enrollment_used`), sets `used_at` atomically (`UPDATE ... WHERE used_at IS NULL`), and creates the device or host.
- `authenticate(req)` takes the cookie or bearer and checks revocation (`device_revoked`).
- A Fastify `onRequest` hook enforces auth on `/api/*` except enroll and hooks, plus the CSRF rules (header and Origin) for cookie-authenticated non-GET requests.
- On first start with zero devices, the coordinator logs a bootstrap enrollment URL plus a terminal QR.
- It writes `admin.token` (0600) into the data dir; it accepts `Authorization: Bearer <admin token>` as an implicit `cli` device named "local admin".

**`src/host-hub.ts`:** `class HostHub`.

- It accepts `/ws/host` and authenticates `hello`.
- For each `event` it dedupes by `event_id`, then applies it to the store (projection: update the session, item, interaction, panel or workspace row), `appendEvent`, and acks the `hostSeq`, all in one transaction.
- `send(hostId, command, timeoutMs = 30000): Promise<Receipt>`:
  - Rejects with `host_unreachable` when not connected.
  - Persists nothing itself; callers persist intent first.
  - Re-sends the same `commandId` on reconnect for commands still awaiting receipt (an in-memory pending map). Host receipts make that idempotent.
- **Connectivity.**
  - On disconnect: `reconnecting`, then `unreachable` after 60 s without reconnect.
  - Affected sessions emit `session.updated` (connectivity derived) and an attention item `host_unreachable` for sessions with running runs.

**`src/routes/*.ts`:** one file per area (auth, devices, hosts, projects, workspaces, profiles, sessions, interactions, tasks, now, automations, hooks, attention, push, ops). Each route validates with protocol schemas and returns entities. Behavior that is not plain CRUD:

- **`POST /api/sessions`:**
  - Validates the project, workspace choice and host connectivity.
  - Creates the Session row (`starting`), a workspace create command when needed, then `session.start`.
  - Returns 202 with the session.
  - The UI shows "Starting…" until `session.updated`.
  - No optimistic success: failure becomes `runtime failed` plus an error item.
- **`POST /api/sessions/:id/prompt {text, mode, clientMessageId}`:** forwards with `origin: human`. When `run.controlMode === "automation"` and the user sends a prompt, it does not change control; the UI warns "Automation is active; take over to stop automatic continuations".
- **`POST /api/interactions/:id/answer {revision, response}`:**
  - Forwards `session.answer`.
  - Returns 200 `{status: "answered", interaction}` or 409 `{error: {code: "already_answered", details: {interaction}}}`.
  - The UI waits for the acknowledgement; there is no optimistic resolution.
- **`POST /api/sessions/:id/takeover`, `/return-to-automation`, `/stop`:** described under Tasks and dispatch.
- **`GET /api/sessions/:id/transcript?before=<ord>&limit=200`.**
- **`POST /api/sessions/import {hostId, sessionFile, projectId}`:**
  - Requires the file to be `inactive` per `session.importable`.
  - Creates the Session with `provenance: "imported"`, runtime `stopped`, and transcript from `session.readNative`.
  - Resume starts Pi with `--session`.

**`src/tasks/state.ts`:**

- `TRANSITIONS`:

| From | To |
|---|---|
| backlog | ready, canceled |
| ready | backlog, in_progress (dispatcher only), canceled |
| in_progress | review, ready (via pause choice), backlog (via pause choice), canceled, done (confirm) |
| review | in_progress (new attempt), done, ready, canceled |
| done | ready (reopen), backlog (reopen) |
| canceled | backlog |

- `move(task, to, opts)` throws `invalid_transition` with a concrete reason, for example "A running task cannot be moved to Backlog without choosing to pause automation or stop execution".
- Moving to `done` with unresolved checks (last run's checks failing or missing while required) or `requireHumanReview` without an explicit accept needs `confirm: true`.
- `detectCycle(taskId, deps)` is a DFS; a cycle gives `dependency_cycle` naming the cycle titles.

**`src/tasks/dispatcher.ts`:** `class Dispatcher`.

- `tick()` runs every 2 s and on relevant events.
- **Eligibility.** For Ready tasks ordered by `(priority, position, createdAt)` it computes `eligibility(task)`, which returns `{eligible: true}` or `{eligible: false, wait}` with `wait` being one of:
  - `dependency` (lists unmet titles)
  - `host_offline`
  - `project_limit`
  - `workspace_occupied` (single-writer and a live session in that workspace)
  - `scheduled_time` (`notBefore`)
  - `invalid_configuration` (no host/profile resolvable, or Pi incompatible)
  - `dispatch_paused`
  - `project_automation_disabled`
- Waits are stored on the task as `blocked: null` (they are queue reasons, not blocks) and exposed via `GET /api/now`.
- **Dispatch.** In one transaction:
  - Insert the Run (`dispatching`, `dispatchKey = run.id`, `controlRevision 1`, automation).
  - Create the Session row (`starting`).
  - Set the task `in_progress`, `currentRunId`, `sessionId`.
  - Events.

  Then `hostHub.send("dispatch.start")`:

  | Result | Run state |
  |---|---|
  | Receipt ok | `running` |
  | Receipt error | `failed`; increment `infraRetries`; if below 2 and the error is pre-start (not `started`), re-queue as `queued` with backoff 30 s, else the task gets `blocked {reason}` plus `failed` attention |
  | Timeout or disconnect | `uncertain` |

- **Reconcile.** On host reconnect, for each `uncertain` run, send `dispatch.reconcile`:
  - Known: adopt its `sessionId` and runtime.
  - Unknown: re-send `dispatch.start` with the same `dispatchKey`.
  - Host unreachable: stays `uncertain`, shown in Now as "Waiting for host <name> to confirm launch". It never dispatches elsewhere.
- **Run prompt.** `buildRunPrompt(task, attempt, feedback)` produces:

  ```
  # Task: <title>\n\n<objective>\n\n## Acceptance criteria\n- ...\n\n
  When you have finished, end your final message with a line `SWITCHYARD: DONE`. If you cannot proceed, end with `SWITCHYARD: BLOCKED <reason>`.
  ```

  Plus the feedback section for attempts after review, and the watch-mode `NO_CHANGE` instruction.

**`src/tasks/runs.ts`:** `onSessionSettled(session, {aborted, lastAssistantText})`.

- If the run is not active or `controlMode === "human"`, record and return.
- If `aborted`, return (Stop handles state).
- Parse the marker:
  - `BLOCKED`: run `failed` with outcome `blocked`; task `blocked {reason}`; `failed` attention.
  - `NO_CHANGE` (watch): run `succeeded`, outcome `no_change`; task `done`, `hiddenFromBoard`; the occurrence records "no change"; no attention.
  - Missing marker, with continuation enabled and limits not exceeded (`continuationsUsed < max`, elapsed < max, tokens and cost under the caps when accounting is available): send `session.prompt` with `mode: prompt`, `origin: automation`, the current `controlRevision`, and text:

    ```
    Continue working toward the objective: <objective>. Continuation <n> of <max>. End with `SWITCHYARD: DONE` when finished or `SWITCHYARD: BLOCKED <reason>`.
    ```

    Increment `continuationsUsed`. A `stale_control` receipt aborts the continuation silently, because takeover won.
  - `DONE`, or no continuation: run checks (task or project) with `checks.run`, state `checking`.
    - All pass, or no checks: run `succeeded`, outcome `review`; task `review`; `ready_for_review` attention.
    - Checks fail with continuation remaining: continue with the failure tails.
    - Otherwise: run `failed`, task `blocked {reason: "Checks failed: <cmd>"}`, `failed` attention.
- Usage comes from `get_session_stats` through the host (`session.updated` carries `stats`). If unavailable, `accounting: "unavailable"` with note "Token/cost accounting not reported by this Pi provider".

**Takeover routes:**

- `takeover`: in a transaction, `controlRevision++` and `controlMode = human`; send `session.setControl`. Continuation, retries and successor dispatch all check `controlMode` before acting.
- `return-to-automation`: `controlRevision++` and `controlMode = automation`; `setControl`; if the session is idle, call `onSessionSettled` with the last assistant text.
- `stop`: `session.abort {clearQueue: true}`; run `canceled` is not set. The run stays with the task `blocked {reason: "Stopped by user"}` and run state `interrupted`; the automation policy is unchanged.
- Detach is client-only and changes nothing.

**Review routes:**

- `accept`: task `done`; run outcome kept; it does not merge or push. The UI text says "Accepting marks the task Done. It does not merge or push."
- `request-changes {feedback: string[]}`: stores `review.feedback` and `changesRequested`; the task stays `review`.
- `new-attempt`: a new Run `attempt+1` on the same session (`session.prompt` with feedback), or a new session if the old one's native session is missing (refused with `native_session_missing` and the alternative "Start fresh session" offered as `new-attempt?fresh=true`).

**`src/automations/scheduler.ts`:** `class Scheduler`.

- `tick()` runs every 15 s.
- **Cron.** Use croner `new Cron(expr, {timezone})` to enumerate occurrences in `(lastEvaluatedAt, now]`, capped at 1000.
  - An occurrence is "missed" if `now - scheduledFor > 120 s`.
  - Missed `skip`: record only the newest missed as `skipped_missed`.
  - Missed `run_once`: fire the newest missed once and record the older ones as `skipped_missed` (only the newest record is kept to bound rows).
  - Non-missed occurrences fire.
  - `key = scheduledFor ISO`. The unique index means a coordinator restart never double-fires; insert-or-ignore decides.
- **`once`:** the same, with a single occurrence.
- **Dependency triggers** fire from `task.updated` when the source task enters `done`; `key = "dep:<taskId>:<doneAt>"`.
- **Webhook:** `POST /api/hooks/:automationId`.
  - Bearer token, sha256-compared in constant time.
  - JSON body ≤ 256 KB.
  - `key = Idempotency-Key` header, or `X-GitHub-Delivery`, or a fresh id.
  - Filters are evaluated against the body (dot paths); no match records `filtered`.
  - Returns 202 `{occurrenceId, state}`.
- **`fire(automation, occurrence, vars)`:**
  - Render the template with `{{date}}`, `{{time}}`, `{{occurrence}}`, `{{payload.<path>}}` by plain string substitution. Payload values are JSON-stringified when not strings and truncated to 24,000 chars total.
  - Overlap: existing tracked work is a non-terminal task with the same `automationId` and the same rendered `groupingKey` (or any non-terminal task of that automation when `groupingKey` is null).
    - `skip`: record `skipped_overlap`.
    - `queue_one`: if no `queued` occurrence exists, record `queued`; fire it when that work leaves `in_progress`/`ready`. Otherwise `skipped_overlap`.
    - `append`: if the task has a live session, send `session.prompt` `mode: followUp`, origin automation, with the rendered objective; otherwise append it to the task objective under "## Update <time>" and move to Ready. Record `appended`.
  - Mode:
    - `fresh` creates a task (Ready, `origin.routine = (trigger.kind === "cron" || trigger.kind === "once")`).
    - `continue` finds the task by `groupingKey` (any state except canceled). If found: set it Ready with `policy.workspace` existing and the same session, and new runs reuse its session. Else create.
    - `watch` is `fresh` plus the `NO_CHANGE` instruction.
  - Routine tasks reaching `done` without attention get `hiddenFromBoard: true` and are visible in automation history.
- `preview(automation)` returns `{summary: string, task: rendered Task draft, next: ISO[] (next 5)}`.
- The human-readable summary is built by `describeTrigger()`, for example "Every weekday at 09:00 (America/Denver)", using a small cron describer covering `m h dom mon dow` with `*`, lists and steps, and falling back to the raw expression.

**`src/attention/*.ts`:**

- **`AttentionService.raise(...)`** keeps one open item per `(sessionId|taskId, reason)`.
- **Resolution:**
  - Answering the interaction resolves `needs_input`.
  - The task leaving review resolves `ready_for_review`.
  - A new run or retry resolves `failed`.
  - Acknowledge sets only `acknowledgedAt`.
- **`NotificationRouter.route(item)`.** It runs after the attention commit and sends at most one notification per session state:
  1. Check presence leases. A foreground client viewing the session (`viewing.sessionId === sessionId` and the foreground lease, 45 s, unexpired) gets inline only; no push.
  2. Otherwise, if a desktop browser or terminal had interaction within 5 min (`interactedAt`), send a desktop web push to that device's subscription (when present) and suppress mobile.
  3. Otherwise push to the preferred mobile device, or the most recently seen PWA.
  4. Quiet hours (`{start: "22:00", end: "07:00", timezone}`) suppress pushes, while the attention item is still recorded.
  5. Private previews replace the summary with "Open Switchyard to view".
- **Payload:** `{title: "<project> · <task or session title>", body: "<Needs input|Failed|Ready for review>: <summary>", tag: "session-<sessionId>", url: deepLink, renotify: true}`.
- **Resolution and test:** resolving sends a `{type: "clear", tag}` push to the device last notified (best effort). `POST /api/push/test` sends "Test notification from Switchyard".
- **Deep links:**
  - `/code/<sessionId>?interaction=<id>` for input.
  - `/tasks/<taskId>` for review and failed.
  - `/code/<sessionId>` otherwise.

**`src/push.ts`:** VAPID keys are generated on first start (`web-push.generateVAPIDKeys`) and stored in `settings`. A 404/410 from the push service deletes the subscription.

**`src/ops.ts`:**

- `/healthz` returns `{ok: true}`.
- `/readyz` runs a DB `select 1`.
- `GET /api/diagnostics` returns versions, the migration level, host list with Pi versions and compatibility, adapter diagnostics (latest 100 `diagnostic` events), the event `seq` range, and push config.
- Backup and restore functions are exported for the CLI:
  - `backup(dataDir, outFile)` does `VACUUM INTO`.
  - `restore(dataDir, file)` refuses while `coordinator.lock` (pid file) names a live pid. It validates `schema_migrations` against the known migrations (newer means refuse), then copies into place with the old DB kept as `coordinator.db.bak-<ts>`.

**`src/logger.ts`:** pino with `redact: ["req.headers.authorization", "req.headers.cookie", "*.credential", "*.token", "*.keys", "*.p256dh", "*.auth"]`.

**`src/server.ts`:** `createCoordinator({dataDir, publicUrl, listen, trustedOrigins, webDist})` returns `{app, start(), stop()}`. It serves `webDist` statically with SPA fallback to `index.html` for non-`/api` and non-`/ws` paths.

### `packages/web`

**Structure:**

- `src/main.tsx`, `src/app/routes.tsx` (the routes of spec §10, plus `/enroll`, `/settings/*`, `/more`)
- `src/sync/` (`client.ts`: WS with cursor, replay or snapshot, reconnect state; `store.ts`: Zustand normalized entities; `api.ts`: fetch wrapper adding `X-Switchyard-Request: 1` and mapping `ApiError`)
- `src/drafts.ts`: localStorage key `sy:draft:<sessionId>`, saved on input (debounced 300 ms); also review comments `sy:review:<sessionId>`
- `src/prefs.ts`: per-device persisted filters, selected project, pane sizes and last session, under `sy:prefs`
- `src/presence.ts`: visibilitychange, pointer and key interaction, `viewing`
- `src/components/ui/` (the design system)
- `src/components/intent/` (the `UINode` renderer, including `FormRenderer` with the `showIf` support and a `CustomFrame` for adapter web renderers in `<iframe sandbox="allow-scripts">` loaded from `/adapter-frames/:adapterId`, with no allow-same-origin)
- `src/features/{code,board,attention,now,automations,settings,enroll}/`
- `src/sw.ts` (service worker: precache, `push` uses `showNotification(title, {tag, body, data: {url}, renotify})` or, for `clear`, closes notifications with that tag; `notificationclick` focuses or opens `data.url`)

**Layout rules** are binding from spec §§10–14. Concrete components:

- **`AppShell`:**
  - The rail is 64 px; expanding to labels gives 200 px.
  - The bottom nav applies at widths under 768. It hides while `visualViewport.height < window.innerHeight * 0.75` and the focus is in a textarea.
- **`CodeDesktop`.** CSS grid `64px var(--nav) minmax(420px,1fr) var(--insp)`.
  - Resizable splitters with clamps of 220–360 and 320–600, persisted.
  - At 768–1199 the inspector is an overlay drawer.
- **`Navigator`, `ConversationHeader`, `Transcript`, `Composer`, `Inspector`** (with Changes, Files, Task and Extensions tabs).
- **`Transcript`.**
  - Sticky-bottom only when the user is at the bottom, within 48 px.
  - Otherwise it shows "Jump to latest (N)".
  - It has the "Needs your answer" strip.
  - `ToolCard` shows the name, a text-plus-icon status, the summary, elapsed time, and `<details>` for args and output (collapsed by default on mobile).
- **`Composer`.**
  - The textarea auto-grows; desktop Enter sends, Shift+Enter inserts a newline.
  - The setting "Send with Enter" is in Settings › This device.
  - On mobile Return inserts a newline and there is a Send button. The max height is 33vh.
  - While running, two buttons: "Steer" (shown only if `capabilities.steer`) and "Queue follow-up".
  - When disabled, the reason is shown inline: "Host offline", "Session stopped: Resume to send", "Read-only subagent view".
- **`CodeMobile`:** a header with back, title, status and overflow; a metadata row; a segmented control (Chat, Changes, Details); a full-screen diff view with previous/next; sheets for attachments, commands and creation steps.
- **`BoardDesktop`.**
  - Columns are 320 px (clamped 288–360) with sticky headers.
  - The drawer is 520 px.
  - Drag and drop uses `@dnd-kit/core` with keyboard sensors.
  - Each card has a menu "Move to…".
  - The `onRunning` choice dialog has "Pause automation" (takeover) and "Stop execution" (stop).
- **`BoardMobile`:** status tabs with counts, full-width cards, a List toggle, a full-screen `TaskDetail`, and a "Move task" action sheet.
- **`TaskDetail`:**
  - The new-task compact form.
  - The "Make ready" preview, fetched from `GET /api/tasks/:id/eligibility`, which returns the dispatcher wait reason, showing "Will start automatically on <host>" or "Will wait: <reason>".
- **Attention, Now, Automations (list, editor with `Preview resulting task`, history) and Settings** (Hosts, Devices with "Add device" QR, Projects, Profiles, Adapters, Notifications with permission status, onboarding steps for the iOS Home Screen, test notification, quiet hours and private previews, Backups, Diagnostics).
- **State components:**
  - `LoadingState`, `EmptyState` (with a next action), `ReconnectingBanner` ("Reconnecting… showing last known data from <time>").
  - `HostUnavailable`, `UnsupportedCapability`, `ErrorState` (retry), `FatalError` (diagnostics link), and toast feedback for successful mutations.
  - Each primary view uses all nine (spec §18).
- **Status always pairs an icon with a text label.** Light and dark come from `prefers-color-scheme` via CSS variables. Touch targets are at least 44 px on coarse pointers.

### `packages/terminal`

- **`src/app.tsx`** (Ink) has three screens:
  - Session list, grouped by project, with `/` to search.
  - Session view:
    - Transcript tail with tool cards collapsed to one line.
    - Pending interactions rendered with the `UINode` text renderer: selects with arrow keys and Enter, multiselect with Space, text inputs.
    - Composer: Enter sends, Alt+Enter inserts a newline. While running, Enter queues a follow-up and Ctrl+S steers.
    - Status line with runtime, control and host.
  - Help (`?`).
- **Keys:**

  | Key | Action |
  |---|---|
  | Ctrl+T | take over / return to automation |
  | Ctrl+X | stop (confirm) |
  | Esc | back |
  | Ctrl+C | quit (detach only) |

- It uses the same REST and WS client as web, via `src/client.ts`, with no DOM.
- Presence: `interactedAt` updates on keypress, `foreground` while the terminal is focused (Ink cannot detect focus, so it is treated as foreground for 45 s after each keypress).

### `packages/cli`

`src/main.ts` is the commander program `switchyard`.

**Coordinator and services:**

- `up [--port 7400] [--data-dir] [--public-url] [--dev]`: standalone coordinator plus local host. It auto-enrolls the local host on first start.
- `coordinator start [--data-dir /data] [--listen] [--public-url]`.
- `coordinator backup <out>`, `coordinator restore <file>`, `coordinator migrate`.
- `host enroll --coordinator <url> --token <t> [--name]`.
- `host run`.
- `host install-service`: writes and loads the launchd plist on darwin (`~/Library/LaunchAgents/com.switchyard.host.plist`) or a systemd user unit on linux (`~/.config/systemd/user/switchyard-host.service`, then `systemctl --user enable --now`). Templates live in `deploy/`.
- `host backup <out>`, `host status`.

**Pairing and diagnostics:**

- `pair [--host]`: creates a device or host enrollment via the admin token and prints the URL plus a terminal QR.
- `doctor`: checks Node, pi version and range, git, coordinator reachability, host link and push config. Prints PASS/FAIL lines.

**Work commands:**

- `sessions list`, `sessions import <file> --project`.
- `attach [sessionId]`: launches the terminal app.
- `tasks create --project --title --objective [--criteria ...] [--ready]`, `tasks list [--state]`, `tasks move <id> <state> [--confirm]`.
- `automations list`, `automations run <id>`.
- `--json` output on list commands.

**Credentials:** `~/.config/switchyard/client.json` stores `{coordinatorUrl, credential}`. `switchyard login --coordinator <url> --token <enrollment token>` enrolls this terminal as a `terminal` device.

### Deployment and docs

- **`Dockerfile`:**
  - Multi-stage: build with pnpm, then `node:26-bookworm-slim` running `switchyard coordinator start --data-dir /data`.
  - `USER node`, `EXPOSE 7400`, `VOLUME /data`.
  - `HEALTHCHECK` with `node -e "fetch('http://127.0.0.1:7400/healthz')..."`.
  - No docker socket, no home mount.
- **`deploy/compose.yaml`:** service `switchyard` with `./data:/data`, env `SWITCHYARD_PUBLIC_URL` and `SWITCHYARD_TRUSTED_ORIGINS`, Traefik labels commented with the router rule and websecure entrypoint, `restart: unless-stopped`.
- **`deploy/traefik.example.yaml`.**
- **`docs/deployment.md`:**
  - Standalone and hub modes.
  - LAN, VPN and reverse proxy; QR does not provide connectivity.
  - iOS Home Screen push onboarding.
  - Privilege model: Pi runs with host-agent user privileges; Docker does not sandbox execution.
- **Other docs:**
  - `docs/operations.md`: backup, restore, migrations, retention, logs, health.
  - `docs/adapters.md`: manifest, hooks, precedence, web renderer bridge, a worked example.
  - `docs/protocol.md`.
  - `docs/sources.md`: the pins table in Appendix B.
  - `docs/compatibility.md`: tested Pi and plugin versions plus the capability table.
  - `docs/acceptance-report.md`: each spec §19 item and the §1 journey step marked Verified (with the test name), Unverified (with the reason, e.g. real iOS push delivery), or Failed.
- **`README.md`:** quick start (`pnpm i && pnpm build && node packages/cli/dist/main.js up`).

## Steps

The work runs in waves. Workers in the same wave must touch disjoint packages; they share one checkout. After each wave: review diffs, run `pnpm build && pnpm test`, and commit per package with conventional commits.

**Wave 0** (this session, by hand):

1. `git init`, root tooling files and `docs/spec.md` (Appendix A verbatim), plus `docs/sources.md` (Appendix B).
2. Write `packages/protocol` completely, with unit tests (schema round-trips, `validateUINode` limits, `branchSlug`).
3. `pnpm install` and `pnpm build`.
4. Commit `chore: scaffold monorepo` and `feat(protocol): …`.
5. `gh repo create justmytwospence/switchyard --private --source . --push`.

**Wave 1** (parallel workers):

- A: `test-fixtures` + `pi-runtime`, including the gate tests. Then fill in `docs/compatibility.md` from the results.
- B: `coordinator` foundation: db, store, auth, enrollment, `host-hub`, client WS sync, routes for devices, hosts, projects, profiles, sessions, interactions, attention and ops.
- C: `adapter-sdk` + `adapter-examples` (unit-tested against recorded request payloads; real-plugin tests come in Wave 3).
- D: `web` shell: design system, `AppShell`, sync client and store, enroll page, state components.

**Wave 2** (parallel; needs Wave 1):

- E: `host-agent` complete (needs A and C).
- F: coordinator tasks, dispatcher, runs, takeover and review, scheduler, automations and webhooks, attention and push routing.
- G: web Code desktop and mobile.
- H: web Board desktop and mobile, plus Attention, Now, Automations and Settings.

**Wave 3** (parallel):

- I: `terminal` + `cli` + deploy files + `Dockerfile`.
- J: cross-package integration tests in `packages/coordinator/test/integration/` (coordinator plus a real host-agent plus real Pi plus the mock model).
- K: Playwright e2e for the four views at four viewports, plus the plugin compatibility tests.

**Wave 4** (this session): docs, acceptance journey run, `docs/acceptance-report.md`, final review (an independent reviewer subagent over the whole diff against the spec), fixes, push.

## Verification

**Commands:**

- `pnpm build` compiles every package and the web bundle with zero TypeScript errors.
- `pnpm lint` passes.
- `pnpm test` passes. Real-Pi tests run (not skipped) locally, where `pi --version` is 1.4.0.
- `pnpm test:e2e` passes all projects: `desktop-1440x900`, `compact-1024x768`, `mobile-390x844`, `mobile-360x740`.
- `docker build -t switchyard .` succeeds. `docker run -p 7400:7400 -v $PWD/.tmp-data:/data switchyard` answers `/healthz`. This is run as project `switchyard-test`; no other Compose project is touched.
- `node packages/cli/dist/main.js doctor` prints all PASS on this Mac.

**Integration tests (J)**, in `packages/coordinator/test/integration/*.test.ts`. Each spins up a coordinator on a temp data dir and port 0, a host agent with a temp state dir and `PI_CODING_AGENT_DIR` mock env, and a temp git repo:

- `shared-session.test.ts`: two client WS connections (terminal and web device credentials). One prompts; both receive identical durable events and transcript items; the session `nativeHandle.sessionFile` is the same.
- `interaction-race.test.ts`: `fixture_select`, then two answers are posted concurrently. Exactly one is 200 and the other 409 `already_answered` with the accepted resolution. Pi received exactly one `extension_ui_response`.
- `dispatch-dedupe.test.ts`: the host test hook drops the first receipt; the run goes `uncertain`; reconnect, then `dispatch.reconcile`, adopts the same session. Exactly one Pi process was spawned, and exactly one worktree.
- `coordinator-restart.test.ts`:
  1. Start a task run with `fixture_slow`.
  2. Stop the coordinator while running; the host keeps executing.
  3. Restart the coordinator on the same data dir; the host replays its outbox.
  4. The run completes into Review once; no second `dispatch.start` is received by the host (counted).
- `host-interruption.test.ts`: kill the Pi child; session `interrupted`, `nativeHandle` kept. Resume continues with the same `sessionId`. Deleting the file, then resume, gives `native_session_missing` and no new session file is created.
- `worktrees.test.ts`:
  - A managed worktree at `<repo>/.worktrees/feat-x` for branch `feat/x`.
  - An external `git worktree add /tmp/...` is discovered as `discovered`.
  - Branch `bad..name` gives `branch_invalid`; an existing path gives `path_collision`.
  - Removal of a dirty worktree is refused without force; removal with a live session gives `workspace_active_sessions`.
- `scheduler.test.ts`, using a fake clock injected into `Scheduler`:
  - Cron in `America/Denver` across a DST change fires at local 09:00.
  - Missed `skip` versus `run_once`.
  - All three overlap policies.
  - A dependency trigger.
  - A restart does not double-fire (same `key`).
  - A dependency cycle is rejected.
- `takeover-race.test.ts`: run with continuation enabled. At `agent_settled`, issue takeover concurrently with the continuation. Either the continuation lands before takeover (and is then the last automated command) or it is rejected `stale_control`. After takeover, no automated prompt is ever accepted by the host (assert via host command log).
- `adapter-failure.test.ts`: a project-tier adapter that throws in `claimInteraction` for the tool-gate fixture. The request falls back to the generic form, a diagnostic is emitted, and the call stays blocked until a human answers. No `extension_ui_response` is sent automatically.
- `enrollment.test.ts`: an expired token gives `enrollment_expired`; reuse gives `enrollment_used`; a revoked device's WS is closed with `force_logout` and its REST calls give 401 `device_revoked`.
- `notifications.test.ts`: presence routing with a stubbed web-push sender:
  - The viewing client gets no push.
  - A recent desktop interaction pushes desktop only.
  - Otherwise the preferred mobile device.
  - Quiet hours suppress.
  - Tags are `session-<id>`.
- `journey.test.ts`, the spec §1 journey via API:
  1. Create the task as the mobile device; Make ready.
  2. Dispatched to the host; worktree in `.worktrees/`.
  3. `fixture_select` asked, answered by the desktop device; all clients see `resolved`.
  4. The terminal device takes over, then returns to automation.
  5. The task reaches Review.
  6. The attention deep link resolves to `/tasks/<id>`.
  7. The coordinator restarts mid-run without duplication.

**Plugin compatibility (K)**, in `packages/adapter-examples/test/compat/*.test.ts`, using real Pi plus the real pi-plugins packages via `-e`:

- `ask-user-question.compat.test.ts`: the mock calls `ask_user_question` with 2 questions (one multiSelect with previews). The adapter claims; we submit `{q1: "Apple", q2: ["A","C"]}`. The tool result `details.answers` match, and no comma-entry was required from the user.
- `tool-gate.compat.test.ts`: `/approvals` is answered to manual "default" via the generic select. The mock calls `bash`; the adapter renders the approval card; we answer `Block`; the tool result is blocked.
- `todo-panel.compat.test.ts` and `bg-panel.compat.test.ts`: the panels update.
- `subagents.compat.test.ts`: a `subagent` run produces a subagent transcript item with `sessionFile`.

Each records the pi-plugins `git rev-parse HEAD` and package versions into `docs/compatibility.md`. Without the plugins directory they skip with "pi-plugins not found at <path>", and the acceptance report marks them Unverified.

**Playwright (K)**, in `packages/web/e2e/*.spec.ts` against a coordinator plus a host with the mock model:

- `code-desktop.spec.ts`:
  - Pane widths: 264 default, clamps.
  - The inspector collapses.
  - Jump to latest does not autoscroll while reading.
  - The Needs-your-answer strip, Enter versus Shift+Enter.
  - Review comments are batched into one follow-up.
  - Keyboard-only navigation through the navigator.
- `code-mobile.spec.ts`:
  - Single surface; Chat, Changes and Details switch.
  - Return inserts a newline and Send sends.
  - Composer max height is 33vh.
  - Full-screen diff with previous/next.
  - A multiselect question answered by tapping.
  - Bottom nav hidden while composing (simulated by resizing `visualViewport`).
- `board-desktop.spec.ts`:
  - Five columns, 288–360 px.
  - Drag Backlog to Ready authorizes dispatch.
  - Dragging a running card backward opens the pause-or-stop choice.
  - Done requires confirmation.
  - The menu and keyboard move equivalents.
  - The drawer is 520 px.
- `board-mobile.spec.ts`:
  - Status tabs with counts; List toggle.
  - Card to full-screen detail, then Back preserves scroll.
  - The Move-task sheet; the compact new-task form with ready preview; filter chips.
- `shared.spec.ts`, at every viewport:
  - `document.documentElement.scrollWidth <= innerWidth`.
  - Drafts survive navigation and reload.
  - Deep links survive enrollment redirect and reconnect.
  - Focus returns to the trigger after a drawer or sheet closes.
  - Status chips have text.

**Manual (Wave 4):**

- Real browser push on this Mac (Chrome) is verified by hand through `terminal-browser` or the user. Real iOS PWA push is marked Unverified unless the user tests it.

## Out of scope

- Everything in spec §3 Deferred.
- No homelab stack changes: deploying the coordinator to the NUC is a follow-up in `~/Projects/homelab`.
- No changes to `~/Projects/pi-plugins`; adapters live in this repo.
- No edits to `~/.pi` or dotfiles. Host service install happens only when the user runs `switchyard host install-service`.
- No starting or recreating other Compose projects.

## Handoff notes

**Verified facts:**

- Pi 1.4.0 is installed at `/opt/homebrew/Cellar/pi-coding-agent/1.4.0`. RPC docs are in its `docs/rpc*.md`.
- `RpcClient` exists but cannot answer extension UI.
- `custom()` returns `undefined` in RPC mode (`dist/modes/rpc/rpc-mode.js:152`).
- `ui_prompt_start`/`ui_prompt_end` reach extensions with `kind` (`dist/core/extensions/types.d.ts:806-820`). Nested prompts are depth-counted, so only the outermost emits.
- **Sessions and events:**
  - There is no session-file locking: enforce one process per session file in the host (a refusal error `conflict` "Session already live on this host").
  - `get_entries {since}` is a durable cursor.
  - Message events carry no ids: assign item ids in the host (the `itm_` ulid at `message_start`, reused at `message_end`).
- **`prompt` while streaming** without `streamingBehavior` is an error; use `steer`/`follow_up`.
- **Abort:** `abort` continues queued messages; Stop must `clear_queue` first.
- **Dialogs without a timeout block the run indefinitely.** That is desired (answer later from any device), but Stop must still work: `abort` resolves pending dialogs with defaults, and the bridge `ui_prompt_end` then marks interactions `expired`.
- **pi-ask-user-question in RPC** (Pi 1.2.0 code in pi-plugins):
  - Single select: options `"n. label - description"` plus a final `"N. Type something."`, followed by `input`.
  - Multi-select is one `input` expecting `"1,3"`.
  - The select title is `[header] question` plus preview blocks.
  - Follow-ups with unmet `showIf` produce no dialog.
  - Verify these against the installed plugin before relying on the exact strings. The compat test is the arbiter.
- **pi-tool-gate in RPC:** `select("Allow this call?\nAction: …", ["Allow once", …, "Block", "Block with a message"])`, with no timeout. It fails closed when `hasUI` is false (not the case in RPC).
- **pi-subagents:** spawns `pi --mode rpc --session-dir <agentDir>/subagents/sessions`. `subagents:run` entries hold `RunView` with `sessionFile`.
- **Test isolation:** `PI_CODING_AGENT_DIR` isolates settings, models, sessions and extensions.
- **`node:sqlite`** works on the installed Node 26.13 (SQLite 3.54.1).
- **Tooling:** pnpm 12.16.1 is installed. Package cooldowns apply; install normally and let pnpm choose versions.

**Pitfalls:**

- Node `readline` splits on U+2028; use the custom JSONL reader.
- Never use `shell: true` with task text.
- Child Pi processes must not be detached.
- In `node:sqlite`, `DatabaseSync` transactions need explicit `BEGIN IMMEDIATE`/`COMMIT`; write a `tx()` helper.
- The Vite dev proxy must forward `/ws` with `ws: true`.

**Most likely to be wrong:**

- The exact prompt strings and dialog ordering of pi-ask-user-question and pi-tool-gate on the user's installed versions. Mitigation: the compat tests; adapters fall back to generic on any mismatch.
- `--session-id <uuid>` creating a new file in RPC mode. The gate test must confirm; fall back to omitting it and reading `get_state`.
- croner's DST behavior. The scheduler test is the arbiter.
- Plugin adapter discovery via settings `packages` sources. If resolution is unreliable, adapters still load from the bundled tier, and the diagnostic says so.

**Credential hygiene:** an earlier `env` listing in this session printed a Bluesky app password from `PI_SIDEBAR_*`. Run `agent-scrub done` after implementation and never print env again.

## Appendix B: source pins (accessed 2026-11-02)

| Source | Revision |
|---|---|
| pi-flows `docs/dashboard-integration.md` | blob `0a0ef692`, commit `24358336` |
| pi-agent-dashboard `intent-types.ts` | commit `3d2b9173` |
| pi-agent-dashboard `plugin-intent-protocol.md` | commit `a95630f1` |
| Paseo `docs/providers.md` | commit `56c05150` |
| Paseo orchestration | https://paseo.sh/docs/orchestration (HTML, accessed date only) |
| Paradev automations and tasks | HTML, accessed date only |
| OpenChamber `session-goals.mdx` | commit `56cf5e29` |
| Pi Durable README | commit `6536f801` |
| Pi `rpc-types.ts` | blob `7fc71516` (identical in v1.4.0, v1.5.0 and main `642e30b6`); npm latest is 1.5.0, installed 1.4.0 |
| Orca mobile, Omnigent mobile, MDN `showNotification`, WebKit Web Push, Vibe Kanban shutdown | links as given in the spec, accessed 2026-11-02 (record in `docs/sources.md`) |
| pi-plugins | record `git rev-parse HEAD` at compat-test time |

## Appendix A: specification (verbatim; copy to `docs/spec.md`)

# Pi Workspace: V1 Product and Implementation Specification

## 1. Product contract

Build a self-hosted Pi metaharness that combines interactive coding, remote execution, plugin interfaces, and scheduled background work.

One persistent session must be accessible from terminal, desktop web, and mobile PWA. A task card, notification, and conversation must reference the same work.

The primary acceptance journey:

> Create a task on the phone. The coordinator dispatches it to the NUC, creates a repo-local worktree, and starts Pi with extensions. A plugin asks a question. Answer on desktop; all clients reflect the answer. Attach from terminal, take over, then return the session to automation. The task finishes into Review. A notification opens the result. Restarting the coordinator never duplicates the run.

This is an implementation specification, not a mockup brief. Build real persistence, execution, synchronization, and failure handling.

## 2. Inspiration map and boundaries

Sources establish precedents. Requirements below define this product's behavior. Do not assume a source implements features beyond what is specifically identified.

Before implementation, record the source revision or documentation access date used. Do not depend blindly on moving upstream branches.

| Source | Specific precedent | Adopt in this product | Deliberate boundary |
|---|---|---|---|
| [Pi Agent Dashboard integration](https://github.com/BlackBeltTechnology/pi-flows/blob/develop/docs/dashboard-integration.md) | Server-owned plugin state and serialized `IntentNode` UI trees | Server-authoritative adapter state; portable components rendered on all clients | Do not assume arbitrary terminal UI is automatically convertible |
| [Paseo provider contract](https://github.com/getpaseo/paseo/blob/main/docs/providers.md) | Pi process-backed RPC; bridging select/input/editor/confirm; native session imports | Explicit runtime capabilities, supported interaction bridging, native session identity | Build a Pi-focused integration rather than copying a multi-provider abstraction wholesale |
| [Paseo orchestration](https://paseo.sh/docs/orchestration) | Agents managed by ID, remote hosts, profiles, fresh scheduled sessions, continuing heartbeats | Stable session addressing; distinguish new scheduled work from continuation | Do not expose every orchestration capability as unconstrained agent authority |
| [Paradev tasks](https://docs.paradev.com/tasks) | Task management connected to agent workspaces | Tasks launch or reference ordinary coding workspaces | A board is a view of task state, not the execution engine |
| [Paradev automations](https://docs.paradev.com/automations) | Schedule/event-triggered runs produce live workspaces users can continue | Automated and interactive work use the same workspace/session model | V1 supports simple rules, not a broad external integration marketplace |
| [OpenChamber](https://github.com/openchamber/openchamber) | Cross-device projects/sessions, review, server-side goals, scheduling | Coding view with conversation and changes; reconnectable work; bounded continuation | Multi-model races, Fusion, and browser-design tools are deferred |
| [OpenChamber goals](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/session-goals.mdx) | Goal execution continues server-side and has pause/resume and limits | Explicit continuation policy, visible budget, takeover distinct from stop | An agent/auditor claim is not sufficient proof that a task passed acceptance |
| [Orca mobile](https://www.onorca.dev/docs/mobile) | Structured mobile chat, questions, files, source control, workspace/agent creation | Mobile is an actionable coding surface, including review | Raw terminal emulation is not the primary phone experience |
| [Omnigent mobile](https://omnigent.ai/docs/interact/mobile) | Terminal/browser/phone access to shared sessions and a configured server | Device-independent session access and central discovery | No requirement to adopt its agent runtime or policy system |
| [Pi plugin suite](https://github.com/justmytwospence/pi-plugins) | Existing questions, planning, tool gates, subagents, background work, review and terminal customizations | Real compatibility fixtures and prioritized adapter coverage | No blanket compatibility claim without testing |
| [Dotfiles phone-access documentation](https://github.com/justmytwospence/dotfiles/blob/main/docs/phone-access.md) | Existing custom-UI/RPC gaps | Make degraded interfaces visible and testable | Never silently discard a required interaction |
| [Homelab host-home architecture](https://github.com/justmytwospence/homelab/blob/main/host-home/README.md) | Execution against actual host development environments | Native host agents with local credentials/configuration | Coordinator containers do not need the host home or Docker socket |
| [Owner's repository/worktree convention](https://github.com/justmytwospence/dotfiles) | Repo-contained worktrees and coexistence with other tools | `<repo>/.worktrees/<branch-slug>` plus discovery | No central hidden worktree directory |
| [Web Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification) | Tags and notification click handling | Session-keyed notification replacement and deep links | OS delivery and removal remain best effort |
| [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) | Home Screen PWA push and user permission | Explicit mobile notification onboarding | No guaranteed silent background processing |
| [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) | Separate durable task/extension architecture | Reserve room for a future runtime implementation | No v1 integration or ordinary-plugin compatibility promise |

Herdr supplies the workflow concept of repository/worktree grouping and persistent session navigation. Treat that as an owner requirement, not an assertion about Herdr's internal architecture.

Vibe Kanban is a historical board-oriented precedent, not a deployment dependency. Its [shutdown announcement](https://vibekanban.com/blog/shutdown) makes lifecycle ownership particularly relevant.

## 3. Scope and fixed decisions

### Required

- Standalone and hub-connected operation.
- Native macOS/Linux host agents.
- Docker Compose coordinator.
- Responsive web/PWA, terminal client, scriptable CLI.
- QR enrollment and device revocation.
- Remote headless execution.
- Repo-local worktrees and discovery.
- Persistent Pi conversations.
- Plugin- and user-provided adapters.
- Tasks, dependencies, scheduling, webhooks, bounded continuation.
- Kanban, coding, attention, queue, and automation views.
- Coordinated notifications.
- Human takeover and return to automation.
- Backup, restore, diagnostics, migrations.

### Assumptions

- Single owner, multiple trusted devices and hosts.
- Pi is the harness; do not build another agent loop.
- One managed Pi process owns each live session.
- The terminal interface is a new client of the managed session. Stock Pi TUI preservation is not required.
- Arbitrary Pi terminal widgets need adapters.
- Import inactive existing Pi sessions; do not claim live adoption of unmanaged processes.
- Viewing can move across devices; execution stays on its host.
- Closing clients never stops execution.

### Deferred

Native apps, public relay service, other harnesses, Pi Durable, team permissions, live host migration, arbitrary workflow graphs, browser automation, multi-model races, full IDE editing, and automatic Git merging/deployment.

## 4. Architecture and implementation stack

Use a TypeScript monorepo:

- Node.js supported LTS.
- Fastify HTTP/WebSocket services.
- SQLite WAL with explicit migrations.
- React web client.
- Maintained terminal UI library.
- Shared runtime-validated protocol schemas.
- Standards-based Web Push.
- Vitest and Playwright.

Suggested packages:

- `coordinator`
- `host-agent`
- `web`
- `terminal`
- `cli`
- `protocol`
- `pi-runtime`
- `adapter-sdk`
- `adapter-examples`
- `test-fixtures`

### Coordinator

Owns identities, host/project directory, tasks, scheduling, dispatch, attention, presence, push subscriptions, and client synchronization.

### Host agent

Owns Pi processes, native session handles, repositories, worktrees, local credentials, command receipts, and an event outbox.

Hosts connect outbound to the coordinator.

### Deployment

Standalone runs a coordinator and local host agent; remote hosts may register.

Hub-connected runs the coordinator in Compose with persistent storage; native host agents register with it.

Both use identical protocols and schemas. Schedules execute in standalone mode while its coordinator is awake.

Support direct HTTPS over LAN/VPN/reverse proxy. Supply Traefik-compatible deployment guidance. QR enrollment does not provide network connectivity.

The coordinator needs neither the host home mount nor Docker socket.

## 5. Data model and authority

| Entity | Essential fields |
|---|---|
| Project | ID, name, repository identity, profiles, workspace/concurrency defaults |
| Checkout | Project, host, absolute clone path, Git common-directory identity |
| Workspace | Checkout, path, branch/base, managed/discovered provenance, Git state |
| Session | Native handle, host/workspace, profile snapshot, runtime state, linked run |
| Task | Objective, acceptance criteria, project, dependencies, priority, state, policy |
| Run | Task/session, dispatch key, attempt, limits, control revision, outcome |
| Automation | Trigger, filters, task template, grouping/overlap/missed-run policy |
| Interaction | Session, ID/revision, payload, allowed responses, resolution |
| Attention item | Session/task, reason, severity, acknowledgment |
| Device | Identity, credentials, presence, push subscription, revocation |

Coordinator owns task/automation decisions. Host owns process state and filesystem truth. Pi owns native conversation history. Coordinator caches presentation history.

Use stable IDs, versioned events, sequence numbers, and idempotency keys.

Hosts persist important events before sending. Clients reconnect with a cursor; server returns missed events or a snapshot plus subsequent events.

Do not order events solely by timestamps.

## 6. Runtime behavior

Runtime states:

`starting`, `idle`, `running`, `waiting_input`, `interrupted`, `failed`, `stopped`.

Connectivity is separate:

`connected`, `reconnecting`, `unreachable`.

Required operations: create, attach, detach, prompt, supported steering, queue follow-up, answer, abort, resume, archive, import inactive session.

All client commands are serialized by the host.

Interaction answers atomically match ID and revision. A second answer returns "Already answered" and the accepted result.

Drafts are device-local and session-keyed.

Unexpected runtime exit preserves the native handle and marks interruption. Resumption must retain identity; failure must never silently create a new session.

Do not automatically replay uncertain side effects after crashes.

### Upstream compatibility gate

Before building the full UI:

1. Inspect current Pi APIs.
2. Pin a tested version range.
3. Implement real question/answer, abort, resume, and reconnect tests.
4. Record supported capabilities.
5. Expose unsupported capabilities honestly.

Never invent Pi RPC methods.

## 7. Adapter contract

Resolution precedence:

1. Project override.
2. Owner override.
3. Plugin-provided adapter.
4. Generic renderer.

Manifest includes ID/version, target extension/version range, protocol version, server entry, optional custom web renderer, and capabilities.

Adapters support tool cards, forms, panels, commands, progress, subagent links, semantic attention, persistent state, and validated actions.

Portable components:

- Text/markdown/code/diff.
- Lists/tables.
- Select/multiselect.
- Text/multiline input.
- Confirmation/form.
- Actions.
- Progress.
- Sections/tabs.
- File/session references.

State remains server-authoritative.

Custom web renderers use isolated frames and a restricted message bridge without application credentials. Server adapter code is trusted installed code, not sandboxed code.

Unknown tools show generic arguments/output/status.

Unsupported interaction displays a compatibility error and available alternatives. Never auto-approve or silently drop it.

Ship real compatibility tests for representative structured questions, approval gates, persistent panels, and subagent events. Record precise tested plugin versions.

## 8. Workspaces

Managed worktrees use:

`<repo>/.worktrees/<branch-slug>`

Discover external worktrees through machine-readable Git output.

Validate paths, branch names, collisions, repository identity, and common-directory ownership.

Default to one writer per workspace; allow explicit shared use.

Show branch/base, dirty state, active sessions, linked tasks, and setup status.

Setup hooks stream output and surface failure.

Finishing a session never deletes its workspace.

Removal checks active sessions, dirty files, and unmerged changes. Destructive overrides are explicit.

No implicit manipulation of unrelated Compose projects.

## 9. Task and automation semantics

Task states:

`Backlog → Ready → In progress → Review → Done`

Also support Canceled. Blocked is an additional condition with a reason.

Moving to Ready authorizes dispatch if project automation is enabled.

A completed agent turn does not complete the task. Default successful outcome is Review.

### Eligibility

Require satisfied dependencies, available host, capacity, workspace access, valid configuration, and no existing dispatch.

Detect dependency cycles.

Persist dispatch before contacting host. Host persists the dispatch key and reuses the same execution for duplicate requests.

Reconcile uncertain launches before retrying. Never fail over an unreachable run automatically.

### Triggers

Manual, one-time timestamp, timezone-aware cron, authenticated webhook, dependency completion.

Persist occurrence IDs to prevent duplicate schedule execution.

Missed-run policies: skip or run once on return.

Overlap policies: skip, queue one pending occurrence, or append to existing tracked work.

### Automation modes

- Fresh task/run.
- Continue task selected by explicit grouping key.
- Watch with attention only on relevant changes.

Routine recurring successes stay in automation history rather than flooding the board.

### Limits

Separate infrastructure retries, agent continuation, and new attempts after feedback.

Continuation defaults off. When enabled, require objective, maximum continuations, and elapsed-time limit. Enforce supported token/cost limits and disclose unavailable accounting.

Acceptance may require configured checks or human review.

### Takeover

Join observes and permits input.

Take over suspends automatic continuations, retries, and successor launches.

Return to automation explicitly restores policy.

Stop aborts current execution.

Takeover increments a control revision checked before automated commands. Detach does not resume automation.

## 10. Web application design system

These are binding product decisions, not copied upstream layouts.

### Responsive behavior

- Desktop: at least 1200 CSS pixels.
- Compact/tablet: 768–1199.
- Mobile: below 768.
- Verify at 1440×900, 1024×768, 390×844, and 360×740.

Support system light/dark themes with restrained surfaces, clear borders, readable text, and no decorative dashboard charts.

Use text plus icons for status. Never rely on color alone.

Touch targets: at least 44×44 CSS pixels. Respect safe areas and on-screen keyboards.

Use consistent terminology: task, run, session, workspace, host.

### Navigation

Desktop global rail: 64 pixels wide, labeled on expansion.

Destinations:

- Code.
- Board.
- Attention.
- Now.
- Automations.
- Settings.

Mobile bottom navigation: Code, Board, Attention, More. More contains Now, Automations, and Settings.

Hide bottom navigation while composing with the keyboard; preserve access through Back/header controls.

Persist filters, selected project, pane sizes, and last session per device.

Canonical routes:

- `/code/:sessionId`
- `/board`
- `/tasks/:taskId`
- `/attention`
- `/now`
- `/automations/:automationId`

Interactions can be addressed with a session-route query parameter. Deep links survive authentication and reconnect.

## 11. Desktop coding view

### Layout

Three main panes after the global rail:

1. Navigator: 264 pixels default, resizable 220–360.
2. Conversation: flexible, minimum 420.
3. Inspector: 380 default, resizable 320–600; collapsible.

At compact widths, inspector overlays or replaces conversation temporarily; do not compress all three panes into unusable columns.

### Navigator

Hierarchy:

Project → workspace → sessions.

Workspace rows show branch and host. Session rows show title, textual status, last activity, and attention indicator.

Provide search, active/all filter, collapse controls, and New session.

Empty state: "Add a project" and "Connect a host," based on what is missing.

New session flow:

- Select project.
- Select existing workspace or create worktree.
- Select host/check-out.
- Select Pi profile.
- Enter initial prompt.
- Show resulting branch/path before creation.

Do not require a task.

### Conversation header

Show session title, project/branch, host, runtime status, and automation-control state.

Actions:

- Open linked task.
- Take over / Return to automation.
- Stop, when running.
- Session menu: rename, archive, native-session information.

Attach is navigation to this view, not an action that creates a process.

### Transcript

Readable messages with restrained tool cards.

Tool cards show name, status, useful summary, elapsed time, and expandable arguments/output.

Maintain scroll position when the user reads history. Show "Jump to latest" with unseen-event count; do not pull the viewport downward.

Pending interactions appear inline and in a persistent "Needs your answer" strip linking to the first unanswered item.

Subagents appear as linked rows/cards with status. Opening one uses the same session interface where supported.

### Composer

Multiline draft, attachments, slash-command picker, profile/model/effort controls where supported.

Desktop Enter sends; Shift+Enter adds newline. Allow configuration.

While running, distinguish "Steer" from "Queue follow-up" according to runtime capabilities. Do not label unsupported immediate steering as available.

Show takeover state clearly.

### Inspector

Tabs:

- Changes.
- Files.
- Task.
- Extensions.

Changes: changed-file list, added/deleted counts, selected diff, refresh state, review comments.

Files: read-only browsing in v1.

Task: objective, criteria, dependencies, limits, run history, takeover controls.

Extensions: registered panels and adapter compatibility diagnostics.

Review comments can be collected and sent as one follow-up. Do not silently send each comment immediately.

## 12. Mobile coding view

### Layout

One primary surface at a time. No miniature desktop sidebars.

Header:

- Back to session list.
- Session title.
- Status.
- Overflow menu.

A compact metadata row shows project, branch, host, and automation state; expandable for details.

View switcher:

- Chat.
- Changes.
- Details.

### Chat

Same authoritative transcript and interactions as desktop.

Collapse verbose tool output by default. Preserve access to full output.

Composer remains above the keyboard, grows to approximately one-third of viewport height, then scrolls internally.

Mobile Return inserts a newline; use an explicit Send button.

Attachments and commands open bottom sheets.

Structured questions render as full-width cards or sheets with visible submit/cancel behavior. Multi-select must not require entering comma-separated numbers when an adapter supplies structured options.

### Changes

Changed-file list first. Selecting a file opens a full-screen unified diff.

Provide previous/next file, line-comment selection, and collected feedback.

Use unified diff on mobile. Horizontal scrolling is confined to code blocks, not the page.

"Request changes" sends accumulated feedback and leaves the task in Review until a new attempt is requested.

"Accept task" is explicit and does not imply merge or push.

### Details

Task criteria, host/workspace, subagents, limits, automation state, and extension panels.

Take over, Return to automation, and Stop are separate labeled actions.

When a plugin panel is not mobile-compatible, show its fallback and exact limitation; never a blank panel.

### Session list

Grouped by project with status filters and search.

Start a new session from mobile using the same creation fields as desktop, presented as sequential sheets.

## 13. Desktop kanban view

### Layout

Header: board title, project selector, search, filters, New task.

Secondary toolbar: automation enabled/paused status, queue count, sort, completed-task visibility.

Columns:

Backlog, Ready, In progress, Review, Done.

Each column is 288–360 pixels wide with a sticky title and count. Horizontal scrolling is allowed inside the board.

Canceled tasks appear through a filter, not a permanent default column.

### Task cards

Show:

- Title, at most two lines.
- Project when viewing multiple projects.
- Priority.
- Current execution/blocked reason.
- Host and branch when assigned.
- Dependency count.
- Attention indicator.
- Last meaningful activity.

Do not show raw tokens or technical IDs by default.

Click opens a task drawer approximately 520 pixels wide. A separate "Open session" action opens coding view.

### Task drawer

Sections:

- Objective and acceptance criteria.
- State and blocked explanation.
- Current run and Open session.
- Dependencies.
- Host/profile/workspace policy.
- Limits and completion policy.
- Run history and activity.

Primary action depends on state:

- Backlog: Make ready.
- Ready: Run now, subject to eligibility.
- In progress: Open session.
- Review: Review changes.
- Done: Reopen.

### Drag semantics

Backlog to Ready authorizes dispatch.

Ready to Backlog removes eligibility if dispatch has not started.

Dragging running work backward opens a choice to pause automation or stop execution; never silently kills it.

Moving to Done requires acceptance confirmation when criteria/checks are unresolved.

Reject invalid transitions with a concrete reason. Provide equivalent menus and keyboard controls; dragging is never required.

## 14. Mobile kanban view

Default to one selected status column, with horizontally scrollable status tabs and counts.

Cards occupy full available width. Vertical scrolling remains natural.

Offer a grouped List toggle for users who want several statuses together.

Do not require precision drag-and-drop on mobile.

Card tap opens a full-screen task detail with:

- Back navigation preserving board position.
- Objective and criteria.
- Status and blocked reason.
- Open session.
- Move task action sheet.
- Dependencies and execution details.
- Review/accept controls.

New task uses a compact form:

1. Title and objective.
2. Project.
3. Save to Backlog or Make ready.

Advanced options inherit project defaults and expand on demand.

Making ready must preview whether work starts automatically.

Filters open a sheet; active filters appear as removable chips.

A board notification links directly to task detail or its pending interaction, not the board root.

## 15. Supporting views

### Attention

Grouped by Needs input, Failed, Ready for review.

Each item shows project/task/session, reason, age, and direct action.

Resolving a question updates the same runtime interaction. Acknowledging a notification does not resolve the underlying task.

### Now

Running and queued sections.

Each queued row explains its wait: dependency, host offline, project limit, workspace occupied, scheduled time, or invalid configuration.

Allow priority changes and pause of future dispatch without terminating active runs.

### Automations

List with enabled state, trigger summary, next occurrence, last outcome, and failure count.

Editor fields:

- Trigger.
- Filters.
- Task template.
- Project/profile/host.
- Fresh versus continue-existing.
- Grouping.
- Overlap.
- Missed-run policy.
- Limits and review policy.

Include a human-readable summary and "Preview resulting task."

Provide history separate from development-board tasks.

### Settings

Hosts, devices, projects, Pi profiles, adapters, notifications, backups, diagnostics.

Host detail shows capabilities, connectivity, checkout mappings, and version compatibility.

## 16. Notifications and presence

Attention state is authoritative; OS notifications are projections.

One stable notification identity per session.

Content: project/task, session, Needs input/Failed/Ready for review, short summary, exact deep link.

Routing:

1. Viewing the session: inline attention.
2. Recently active desktop client: desktop notification, suppress mobile.
3. Otherwise: preferred mobile device.

Use expiring foreground/recent-interaction leases. Socket connection alone is not presence.

Terminal presence is based on interaction. Whole-system Mac activity detection is deferred.

Suppress unwanted mobile push before sending it.

Use notification tags and clear/update where supported. Document platform limitations rather than promising guaranteed cross-device clearing.

Support quiet hours, private previews, preferred device, permission status, and a test notification.

## 17. Security, pairing, and reliability

Single-use, short-lived QR enrollment tokens. Separate revocable device credentials. Separate host enrollment.

Provider credentials stay on execution hosts.

Authenticate connections, validate messages, restrict origins, protect browser mutations, and avoid shell interpolation of task content.

Custom server adapters are trusted code. Web renderers receive restricted capabilities.

Process privilege equals host-agent OS-user privilege; Docker coordinator deployment does not sandbox execution.

Persist dispatch receipts and reconcile uncertain launches.

On coordinator restart, hosts continue execution and replay events.

On host loss, show unreachable; do not fabricate completion or start a replacement elsewhere.

Use structured redacted logs, health endpoints, migrations, retention settings, and consistent backup/restore.

## 18. UI state requirements

Every primary view must implement:

- Initial loading.
- Empty state with next action.
- Reconnecting with last-known-data indication.
- Host unavailable.
- Permission/interaction pending.
- Unsupported capability.
- Recoverable error with retry.
- Irrecoverable error with diagnostics.
- Successful mutation feedback.

Do not disable Send without explaining why.

Do not discard drafts on navigation, transient errors, or reconnect.

Do not use optimistic success for dispatch, destructive workspace actions, or approval resolution before acknowledgment.

Preserve browser Back behavior and accessible focus after drawers/sheets close.

## 19. Verification

Automated tests must cover:

- Real Pi question/answer, resume, abort.
- Simultaneous terminal/web access to one native session.
- Interaction-answer races.
- Dispatch deduplication after lost acknowledgment.
- Coordinator restart during execution.
- Host/process interruption.
- Repo-local worktrees and external discovery.
- Scheduler timezones, overlap, missed runs, dependencies.
- Takeover racing an automatic continuation.
- Adapter failure without approval bypass.
- Enrollment expiration, reuse, and revocation.

Browser tests cover all four primary views at specified sizes:

- Desktop coding.
- Mobile coding.
- Desktop board.
- Mobile board.

Verify keyboard-only use, no accidental full-page horizontal overflow, mobile keyboard behavior, draft persistence, deep links, and notification routing.

Use real mobile/browser verification for OS notification behavior. If unavailable, mark that acceptance item unverified rather than substituting a simulated pass.

## 20. Delivery and implementation order

Implement:

1. Protocol, persistence, host connection.
2. Real Pi runtime and capability contract.
3. Shared-session web/terminal vertical slice.
4. Workspaces and worktrees.
5. Adapters and representative plugin compatibility.
6. Tasks, dispatch, takeover, review.
7. Scheduling, webhooks, dependencies, continuation.
8. Complete four primary UI views.
9. Attention, presence, push, pairing.
10. Compose, operations, backup/restore, acceptance verification.

Deliver runnable code, migrations, deployment files, adapter SDK/examples, tests, documentation, and an acceptance report.

Do not begin with disconnected polished mock screens. Do not label a feature complete because its button exists.

If upstream APIs prevent a requirement, identify the exact limitation and supported fallback. Never conceal a new conversation, lost approval, duplicate execution, or unsupported plugin interaction behind apparent success.
