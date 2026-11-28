# Pi compatibility

Hosts without `checkout.provision.v1` cannot perform managed clone preparation, but can still use existing verified checkouts. New hosts retain the old scan and suggestion wire handlers for older coordinators. Retired folder writes and scans on a new coordinator return guidance rather than creating projects; `hosts folders` reads the new location for migration.

Switchyard drives Pi through `pi --mode rpc`, one child process per live session, with its own JSONL client (`packages/pi-runtime`) and a bridge extension (`dist/bridge/switchyard-bridge.js`) loaded with `-e`.

- **Pi version tested:** 1.4.0 (Homebrew `pi-coding-agent` 1.4.0), on Node 26.13.0.
- **Date:** 2026-11-02.
- **Supported range:** `>=1.4.0 <1.7.0` (`SUPPORTED_RANGE` in `pi-runtime`; prereleases are not accepted).
- **Outside the range:** the host refuses to start sessions with "Pi <v> is outside the tested range >=1.4.0 <1.7.0" (`pi_incompatible`).

The gate tests run the real installed `pi` (override with `SWITCHYARD_PI_BIN`) against a scripted OpenAI Chat Completions SSE server (`test-fixtures/mock-model-server.ts`, provider `mock`, api `openai-completions`) in an isolated `PI_CODING_AGENT_DIR` with `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`. No network, no cost. A missing Pi fails the tests; only `SWITCHYARD_SKIP_REAL_PI=1` skips them.

## Orchestration and policy negotiation

Host and coordinator negotiate optional features without a global protocol version bump. Older hosts remain connected and browsable, but protected launches require a capable host and Pi `>=1.5.0 <1.7.0`. Actual bridge state, not host capability alone, determines protection. A live Pi process with an older bridge remains unprotected until explicitly reloaded or restarted; it is not silently restarted. See [operations.md](operations.md#upgrading) and [policies.md](policies.md). Feature negotiation is a permanent compatibility mechanism, not a temporary shim.

Pre-provider `model_request` enforcement is deferred; no compatibility claim implies a spending cap during a running turn.

## Adapter development compatibility (dev tranche)

The dev tranche passed its full unit/integration and browser suites on Pi 1.5.2 and a 78-case real-Pi compatibility matrix: baseline and updated suites each passed all 13 cases on Pi 1.4.0, 1.5.0 and 1.5.2, without skips or paid provider calls. The released plugin pair is pi-plugins v0.1.77 (`89d49d91a199116380dd5c0b5f763f8654e941b0`), pinned immutably in `.github/compat-pi-plugins.json`. Development started from Switchyard `4e3db5844a4e174541d7b696fa59ca459d129c60` (0.13.0) and pi-plugins `60fdc72e805b8db030ae1739fe39e3b600e10ac1` (0.1.75); verification details are in [acceptance-report.md](acceptance-report.md). The supported Pi range above is unchanged; these results do not imply that every optional capability works on each version. See [plugin-boundaries.md](plugin-boundaries.md) for ownership.

Session discovery uses the installed Pi's read-only resource resolver and the bridge's live trust and reported tool/command source paths. Project settings are considered only with confirmed trust; configured-enabled paths are not proof of a complete runtime inventory. Entrypoint-bound adapters require both enabled and reported evidence; legacy manifests use package-level matching. Missing bridge/resolver support produces conservative fallback and diagnostics, not speculative project imports. Component versions come from the target package, not the suite provider. Explicit owner adapters remain available; project-tier adapters require trust and an available inventory.

Resource inspection uses its own authenticated read-only binding, independently of the Pi-version gate for optional orchestration and policy enforcement. Startup waits for actual bridge evidence instead of guessing resource support from a version number. When that binding or source/trust APIs are unavailable, generic human-answerable dialogs remain available and entrypoint-bound plugin adapters stay disabled rather than claiming unverified runtime provenance; project adapters are not imported in that fallback.

`adapterDevelopment` gates session inspection and reload. Old hosts remain browsable and keep their legacy presentation and actions, but cannot provide this inspection, safe adapter reload or generation fencing; a missing generation is not generation zero. On new hosts, generation-tagged stale actions are rejected; after a swap, generation-less actions are rejected too. Legacy clients can continue baseline actions before a swap but must update or reopen with generation-aware UI afterward. Full Pi reload requires terminal transport and a bridge able to confirm the replacement runtime; old bridges cannot safely confirm it. An adapter-only reload does not reload Pi or runtime helper imports. See [adapters.md](adapters.md#inspection-and-reload).

## Client capability negotiation (Phase 4)

`/ws/client` hello accepts optional `capabilities` and `projectionId` alongside the existing durable event cursor. New clients advertise `adapter.slots.v1` and `timeline.cards.v1`; the coordinator acknowledges only supported names in snapshot/replay and returns a projection ID for the negotiated set. A reconnect may replay only when the cached projection ID matches; otherwise it sends a full snapshot, so a changed capability set never leaves stale panel representations behind. Old clients omit these fields and receive portable text fallbacks for contributed panels and notices while preserving event sequence numbers and panel tombstones. This is a permanent compatibility mechanism, not a temporary migration shim.

Older hosts still work with a new coordinator and retain their legacy panels and tool cards. New adapter contribution APIs require a new host; upgrade the coordinator before the host, since an old coordinator cannot reliably downgrade new host contribution fields to safe text-only UI. SDK clients connecting to older coordinators can still use baseline REST, cursor replay and snapshots, but do not receive acknowledgement of new slots/cards.

### Adapter contract v2

Contract v2 (tool views, the `checklist`, `facts`, `rows` and `badge` nodes, `section.open`, URL refs, the `composer.tracker` and `session.badge` placements, and an interaction's `kind` and `toolCallId`) is negotiated at both hops, so every pairing of old and new works:

| Pairing | What happens |
|---|---|
| New host, new coordinator | The host advertises `adapterContract.v2` in `hello`; the coordinator echoes it in `welcome`; events carry the v2 shapes. |
| New host, old coordinator | No echo. The host sends each event in its v1 shape (`projectHostEvent`): no tool view, no `kind` or `toolCallId`, a tracker as a `composer.pill`, no badge, v2 nodes redrawn with v1 nodes. Unclaimed statuses stay the legacy Status panel. Adapters still see contract v2 (`ctx.features`). |
| Old host, new coordinator | Nothing new arrives. The web derives each tool row from its name and arguments, as it does for stored items. |
| New coordinator, old client | A client announces `tool.views.v1`, `ui.nodes.v2` and `adapter.trackers.v1`; without one, the coordinator projects that part to its v1 shape per connection, as it does for slots and cards. The projection id covers the new names, so a changed set gets a fresh snapshot. |
| New client, old coordinator | The coordinator acknowledges only the names it knows; the client gets v1 data and draws it. |
| v2 adapter, v1 host | It loads (`protocolVersion` is still 1). `toolView` is never called and `Claim.kind` is ignored. `ctx.features` is undefined, so an adapter that guards its v2 nodes and placements falls back to v1 ones ([adapters.md](adapters.md#feature-detection)). |

The transcript, interaction and panel REST reads are not projected per client; a browser tab older than its coordinator ignores a tool view and draws nothing for a node it does not know.

`queueClear.v1` is a host feature like `gitLog.v1`: the coordinator sends `session.clearQueue` (Edit queue) only to a host that advertised it, and the host reports `capabilities.queueEdit` so clients offer the action only there.

[The typed Node SDK](client-sdk.md) exposes reset notices when replay history is gone; its `sessions.waitForFinish` observes session quiescence, not the completion of a specific submitted message. Pre-provider `model_request` enforcement remains deferred.

## Capabilities

| Capability         | Status      | Mechanism / reason                                                                                                                                                                                                                                                                  |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | Supported   | `prompt` command; response `data.disposition` is `started`, `queued` or `handled`. Switchyard rejects a plain prompt while a run is active ("Session is running: choose Steer or Queue follow-up"); `/command` prompts pass through because Pi runs extension commands immediately. |
| `steer`            | Supported   | `steer` command (`disposition: queued`)                                                                                                                                                                                                                                             |
| `followUp`         | Supported   | `follow_up` command; `queue_update` events carry the full `steering` / `followUp` queues                                                                                                                                                                                            |
| `abort`            | Supported   | `clear_queue` (optional, returns the cleared text) then `abort`; `agent_settled {aborted:true}` arrives before the `abort` response                                                                                                                                                 |
| `resume`           | Supported   | `--session <sessionFile>`; same `sessionId` and file. A missing file fails with `native_session_missing` before spawning                                                                                                                                                            |
| `rename`           | Supported   | `set_session_name`; initial name with `--name`                                                                                                                                                                                                                                      |
| `importInactive`   | Supported   | Session files listed from their header line plus the last `session_info` name; inactive when unmodified for 120 s; read with Pi's `parseSessionEntries` (resolved from the installed `pi`), falling back to a plain JSONL parse                                                     |
| `extensionDialogs` | Supported   | `extension_ui_request` `select` / `confirm` / `input` / `editor`, answered with `extension_ui_response` `{value}` / `{confirmed}` / `{cancelled:true}`                                                                                                                              |
| `widgetsText`      | Supported   | `setWidget` with `widgetLines` (string arrays), plus `setStatus`, `notify`, `setTitle`, `set_editor_text` as fire-and-forget requests                                                                                                                                               |
| `tokenAccounting`  | Supported   | `get_session_stats.tokens.total`                                                                                                                                                                                                                                                    |
| `costAccounting`   | Supported   | `get_session_stats.cost` (USD, from the model's configured prices)                                                                                                                                                                                                                  |
| `sessionControls`  | Supported   | `get_available_models`, `set_model`, `set_thinking_level`, `get_commands`, `compact` and `get_session_stats.contextUsage`, plus `model_state` from the bridge or terminal extension |
| Slash commands in terminal sessions | Supported | `pi.sendUserMessage(..., {expandPromptTemplates: true})` |
| `customUi`         | Unsupported | ctx.ui.custom() returns undefined in RPC mode. Pi sends no request; the bridge reports `ui_prompt_start`/`ui_prompt_end` with kind `custom` so Switchyard can show an unsupported-interaction notice.                                                                               |
| `widgetsComponent` | Unsupported | component widget factories are ignored in RPC mode                                                                                                                                                                                                                                  |

## Host features

| Feature | Meaning |
|---|---|
| Enrolment | A Pi started outside Switchyard with `switchyard-terminal.js` loaded listens on `<runtime>/ext-*.sock` (meta in `ext-*.sock.json`) and plays the holder's control side; the host agent adopts it with the terminal reattach path. The session reports `terminal: false` and `external`. |
| `adapterContract.v2` | Negotiated in `welcome`: the coordinator reads the contract v2 shapes ([above](#adapter-contract-v2)). Without the echo the host sends v1 shapes. |
| `queueClear.v1` | The host answers `session.clearQueue`: Pi's `clear_queue` without an abort, returning the queued messages. Without it Edit queue is not offered. |
| `trackers.v1` | GitHub issue sync for scopes: the host answers `tracker.sync`, `tracker.prepareBranch`, `tracker.startIssue` and `tracker.setStatus`. The feature and its commands keep the names they had when a scope's GitHub source was a tracker, so hosts one release behind keep working. Without it, GitHub scopes on that host report "does not support GitHub issue sync" and nothing else changes. `workspace.remove` `deleteBranch` and `GitState.head` are optional and ignored or absent on older hosts. |

## Scopes and clients (0.21)

0.21 merges views and trackers into scopes and renames the herdr and tmux "terminal" to client ([scopes.md](scopes.md#from-020), [clients.md](clients.md#from-020)). A coordinator at 0.21 keeps daemons, browser tabs and SDK clients from 0.20 working; everything below is marked `COMPAT(scopes-rename): remove after 2027-03-01` in the code.

| Shim | What it does |
|---|---|
| Client capability `scopes.v1` | A client that announces it gets `scopes` and `clients` in snapshots and the `scope.*` and `client.*` events. One that does not (0.20) gets them projected to `views` and `terminals` and to `view.*` and `terminal.*` events, with a GitHub scope as a view that names itself as its tracker and `mirror: "scope"` as `"view"` |
| `GET /api/views`, `GET /api/trackers`, `GET /api/terminals` | List scopes and clients in the 0.20 shapes |
| `PUT /api/terminals/:id`, `PUT /api/terminals/:id/binding`, `DELETE /api/terminals/:id` | A 0.20 daemon's report, binding and removal |
| `POST` and `DELETE /api/views/:id/sessions/:sessionId` | Pin and unpin |
| `viewId` in `POST /api/sessions`, `POST /api/branches/open` and `POST /api/issues/:id/open` | Read as `scopeId` |
| `Presence.terminalId` | Read as `clientId` |
| `TrackedIssue.trackerId` | Written as a copy of `scopeId` |
| CLI `views`, `trackers`, `terminals`, `--view` | Hidden aliases of `scopes`, `clients` and `--scope` that print a notice |

Not kept: creating or editing views and trackers through the old routes (they answer 404; use a 0.21 client), and the 0.19 layer (`/api/surfaces`, `/api/views/:id/clients`, `surfaces` in snapshots, `surface.*` events).

The migration moves `minRetainedSeq` past the last event, so every client takes one snapshot at its next connection and no event from before the upgrade is replayed. A GitHub scope has its tracker's id, not its view's: a browser that had that view selected shows All sessions until the scope is selected again.

The other direction is not supported: a CLI or SDK from 0.21 against an older coordinator finds no `scopes` or `clients`, says so once and mirrors nothing. Upgrade the coordinator first.

The host wire does not change: `tracker.*` commands, the `trackers.v1` and `trackers.board.v1` features and `Session.place.terminalId` keep their names.

## Open issues by repository

The optional host feature `trackers.repositoryIssues.v1` gates repository issue page and single-issue reads. Hosts that only support `trackers.v1`, `trackers.board.v1`, or `trackers.description.v1` keep their existing tracked-issue paths. When no eligible checkout host supports repository reads, Switchyard explains the upgrade and leaves the GitHub link and prompt-based session creation available. Repository results are not added to the sync snapshot. Migration 24 stores only durable issue-to-work associations; back up the coordinator database as described in [operations.md](operations.md#upgrading) before upgrading, because a schema-23 coordinator cannot read schema 24.

## Terminal transport

Hosts with [terminal sessions](terminal-sessions.md) enabled run interactive `pi` in a pty instead of `pi --mode rpc`, with the `switchyard-terminal.js` extension as the control channel. `gate-terminal.test.ts` runs the same real-Pi checks through it: prompt, a select answered remotely and one answered in the terminal, steer, abort, detach and reattach, stop. Pi features the extension API does not expose are listed under the doc's Limits.

## Gate tests

All in `packages/pi-runtime/test/`, run with `pnpm exec vitest run --project pi-runtime`. Result on 2026-11-02 with Pi 1.4.0: 11 files, 34 tests, all passing (not skipped), stable over repeated runs.

| Test                     | What it proves                                                                                                                                                                                                                                                                                                                           | Result |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `jsonl.test.ts`          | LF-only framing: U+2028/U+2029 kept inside strings, CRLF stripped, chunks (including split UTF-8) reassembled, malformed lines reported; `writeJsonl` honours backpressure                                                                                                                                                               | Pass   |
| `gate-prompt.test.ts`    | Prompt then `agent_settled`; user, thinking and assistant items with host-assigned orders from an injected counter; stream deltas match final items; session file exists with the expected header; stats report tokens and cost; prompt-while-running rejected; follow-up queued and drained; `--session-id <uuid>` creates that session | Pass   |
| `gate-question.test.ts`  | `fixture_select` produces a `select` request; answering `Banana` reaches the tool result; runtime goes `waiting_input` and back; bridge reports `ui_prompt_start`/`ui_prompt_end` kind `select`; confirm, input, editor and cancel; `setStatus`/`setWidget`/`notify` forwarded                                                           | Pass   |
| `gate-abort.test.ts`     | `fixture_slow` aborted within 2 s; `agent_settled {aborted:true}`; runtime `idle`; tool item `error`; session usable afterwards; abort with a pending dialog closes it and the bridge `ui_prompt_end` expires it                                                                                                                         | Pass   |
| `gate-resume.test.ts`    | Stop then restart with `--session <file>`: same `sessionId`, `history()` contains the earlier prompt and the model receives the earlier context; rename persists; deleted file gives `native_session_missing` with no process spawned                                                                                                    | Pass   |
| `gate-interrupt.test.ts` | SIGKILL of the child gives `interrupted` with the native handle kept, and the session resumes; requested stop gives `stopped`; spawn failure and an exit during startup give `failed`                                                                                                                                                    | Pass   |
| `gate-custom.test.ts`    | `fixture_custom`: no `extension_ui_request`, bridge reports kind `custom`, tool result `custom returned undefined`                                                                                                                                                                                                                       | Pass   |
| `gate-reconnect.test.ts` | Two listeners (terminal and web through the host fan-out) receive identical sequences; a client attaching mid-stream rebuilds the message from `snapshot()` plus later deltas                                                                                                                                                            | Pass   |
| `bridge.test.ts`         | Bridge is a no-op without `SWITCHYARD_BRIDGE_SOCKET`, forwards JSON lines, never throws on an unreachable socket                                                                                                                                                                                                                         | Pass   |
| `capabilities.test.ts`   | Range checks, the refusal message, missing Pi, and detection of the installed Pi with the capability table above                                                                                                                                                                                                                         | Pass   |
| `gate-controls.test.ts`  | Model and effort listing and switching, `/fixture-hello` through the transport, context usage from `get_session_stats`, and manual compaction, over RPC and terminal; a Vanilla profile (`--no-extensions --no-skills --no-prompt-templates`) still loads Switchyard's bridge and explicit `-e` extensions | Pass   |
| `importable.test.ts`     | `listImportable` header/name/inactive; `readNativeTranscript` with Pi's parser and with the fallback gives the same items                                                                                                                                                                                                                | Pass   |

## Verified Pi behaviour and deviations from the plan

- **`--session-id <uuid>` in RPC mode** creates a new session with exactly that id in the default session directory (`<agentDir>/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`). Pi prints a warning to stderr ("No project session found with id ...; creating a new session with that id."). `get_state` reports the final `sessionFile` immediately.
- **Lazy persistence.** The session file does not exist until the first assistant message is written. A session stopped before any reply therefore cannot be resumed: resume reports `native_session_missing` (by design it never falls back to a fresh session). Hosts should treat such a session as empty.
- **`--session <missing file>` silently creates a new session** (with a new id) at that path. `ManagedSession` therefore checks the file before spawning and also verifies that `get_state.sessionId` equals the expected id.
- **`--name` appends a `session_info` entry on every start**, even when unchanged. On resume, `ManagedSession` passes `--name` only when the file's last `session_info` name differs from the title.
- **`--provider` requires `--model`.** The provider flag is only passed together with a model.
- **Abort ordering.** After `abort`, Pi emits an assistant `message_end` with `stopReason: "error"` and `errorMessage: "This operation was aborted"`, then `agent_settled {aborted:true}`, then the `abort` response. Switchyard suppresses that error notice and emits a "Run aborted" warning notice instead.
- **Dialog requests omit `timeout`** when the extension set none. Pi resolves a timed-out or aborted dialog itself without telling the RPC client; only the bridge `ui_prompt_end` reveals it. Pi reports only the outermost prompt (nested prompts share one start/end pair), so `ManagedSession` expires pending dialogs whose method and title match the `ui_prompt_end`.
- **Bridge and stdout are separate channels**, so `ui_prompt_start` can arrive before or after the matching `extension_ui_request`.
- **Startup failures** (unknown option, unknown model) print `Error: ...` to stderr and exit with code 1; this surfaces as runtime `failed` with the stderr tail in the detail.
- **Tool parameters** may be plain JSON Schema (Pi validates non-TypeBox schemas through its JSON-schema path), so the fixture extension imports nothing.
- **Mock model protocol.** Pi's `openai-completions` client sends `stream: true` and `stream_options: {include_usage: true}`, reads `choices[0].delta.content`, `reasoning_content` (thinking), `tool_calls` deltas, `finish_reason` (required, otherwise "Stream ended without finish_reason") and a final `usage` chunk.
- **Unix socket path length.** Bridge sockets live in `<runtimeDir>/bridge-<id>.sock`; when that path exceeds 100 bytes they fall back to `/tmp/switchyard-<uid>/`.

## Plugin compatibility

The plugin tests in `packages/host-agent/test/compat/` load the real pi-plugins suite from a checkout named by `SWITCHYARD_PI_PLUGINS_DIR` (direct test invocation skips when it is unset). The mandatory `pnpm test:plugins` wrapper instead requires a matching checkout and real Pi; see [development.md](development.md#adapter-development-and-cross-repository-checks). Historically, they exercised discovery as follows: each test writes `<agentDir>/settings.json` with a `packages` entry `{"source": "<pi-plugins dir>", "extensions": ["packages/<name>/src/index.ts"], "skills": [], "prompts": [], "themes": []}` (pi-todo's entry is `packages/pi-todo/index.ts`) instead of passing `pi -e`. Pi loads only those extensions, and the host agent loads the adapters the suite declares in its root `package.json` `switchyard.adapter` through the plugin tier; no adapters are bundled. Each test asserts that the claiming adapter's tier is `plugin` (from the host's `adapters.updated` event). They drive the real host agent (`runHostAgent`, its `SessionSupervisor`, `AdapterCatalog`, and the interaction and panel pipeline) through the fake coordinator from `packages/host-agent/test/helpers.ts`, against real Pi and the scripted mock model. Run them with `pnpm exec vitest run --project host-agent test/compat` after `pnpm exec tsc -b`.

Isolation: each harness has its own `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, an empty temporary `HOME`, and blank `TYPESAFE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`, so plugins cannot use the known model credentials to call a network judge or classifier. They skip with "pi-plugins not found at <path>" when that directory is missing, and with `SWITCHYARD_SKIP_REAL_PI=1`. Each test writes the raw `extension_ui_request` payloads, the responses and its result to `test/compat/.tmp-results/<test>.json` (ignored by git and biome).

The results and observations below are historical, not results for the dev tranche above.

- **2026-11-26:** the pin is pi-plugins v0.1.113 (`53b505d2c105630ae0c002a41f12732da1ab7e8e`), whose adapters use contract v2 on a host that offers it. Two assertions changed with it: `todo-panel.compat.test.ts` now expects the `todo-tracker` contribution (`composer.tracker`, count `0/2`, a `checklist` node) and the `todo-badge` (`session.badge`) instead of the `todo` panel, and `bg-panel.compat.test.ts` expects the `bg-tracker` contribution (a `rows` node with one row per task, `running` then `done`) instead of the status-text panel. The other five files are unchanged. Result with Pi 1.6.0: 7 files, 13 tests, all passing over three runs. The rows for those two tests in the table below describe the earlier panels.
- **2026-11-02:** the adapters now ship in pi-plugins (`packages/<pkg>/src/switchyard/`, commit `ca7f9e22e9559723a7b5b3097b3a771ccc131f49`), and the compat tests load them through the plugin tier. Result at that commit with Pi 1.4.0: 5 files, 6 tests, all passing. The table below describes the earlier run against the bundled adapters; the assertions are unchanged.
- **Date:** 2026-11-02, Pi 1.4.0.
- **pi-plugins commit:** `bbc6ce56243043a91ae53992fb5abc04dc2cbe38`.
- **Result:** 5 files, 6 tests, all passing, stable over repeated runs.

| Test | Package (version) | Result | What it proves |
| --- | --- | --- | --- |
| `ask-user-question.compat.test.ts` | `@justmytwospence/pi-ask-user-question` 0.1.2 | Verified | The mock calls `ask_user_question` with a single-select question with previews and a multiSelect question. The adapter claims the first `select`, and the user answers one form, `{q1: "Apple", q2: ["A", "C"]}`. The host answers the plugin's follow-up multi-select `input` with `"1,3"` ("Answered from your earlier form", resolved by `host`), so the user never types numbers. `details.answers` is `[{kind: "option", answer: "Apple"}, {kind: "multi", selected: ["A", "C"]}]`. The Other path, `{q1: {other: "Durian"}, q2: ["B"]}`, sends `3. Type something.`, then `Durian` to the `Type your answer:` input, then `2`, and gives `answer: "Durian"` (`kind: "custom"`). |
| `tool-gate.compat.test.ts` | `@justmytwospence/pi-tool-gate` 0.1.2 | Verified (see notes) | `/approvals` opens the select `Approvals` with `["Auto", "Yolo"]`, which the generic renderer shows and the host answers with `Auto`. `/gate rules add ask Bash(echo:*) --scope session` adds an ask rule. A `bash echo hello` call then is held, and the `tool-gate` adapter claims the approval select: title `Allow this call? bash`, rows Action `bash`, Target `echo hello`, Held `matches the ask rule Bash(echo:*) (session)`, Agent `(gave no reason)`, and actions `Allow once`, `Block`, `Block with a message`. Answering `Block` sends `{value: "Block"}`. The tool result is an error ("The user declined this call...") and no `system1:decision` entry is written. |
| `todo-panel.compat.test.ts` | `@justmytwospence/pi-todo` 0.1.2 | Verified | The mock calls `todo` with `create`, `create`, then `update {id: 1, status: "in_progress"}`, following the schema Pi declares to the model: `action` is one of create, update, list, get, delete or clear, plus `subject`, `status`, `id` and `activeForm`. Each result carries `details.tasks` as `[{id, subject, status, activeForm?}]`. The `todo` panel ends as `[~] Write the compat tests`, `[ ] Update the docs`, with one panel update per call. |
| `bg-panel.compat.test.ts` | `@justmytwospence/pi-bg` 0.1.2 | Verified | `bg_run {command: "sleep 2; echo compat-done", kind: "job", name: "compat"}` returns `details: {id}`. The plugin reports progress only through `setStatus("bg", ...)`: `bg: compat 0:00`, then `bg: compat 0:01`, then `bg: compat ✓` when the job exits. It sends no `setWidget`. The `bg` panel (web renderer, `state: {status, lines: []}`) follows every update. |
| `subagents.compat.test.ts` | `@justmytwospence/pi-subagents` 0.1.2 | Verified | `subagent {task, label, agent: "general", model: "mock/mock-1", thinking: "off"}` spawns a child Pi that inherits `PI_CODING_AGENT_DIR` and is answered by the same mock. The plugin appends `subagents:run` custom entries (`running`, then `done`), and the result has `details.runs[].sessionFile` (`<agentDir>/subagents/sessions/<ts>_<uuid>.jsonl`). The host emits a `subagent` transcript item `{runId, label: "pong check", status: "done", sessionFile, linkedSessionId: null}`, and the file exists. |

### Adapter format corrections

The adapters' assumed formats (then bundled in `adapter-examples`) matched the real plugins, so no parsing logic changed. Changes:

- `todo`, `bg` and `subagents` manifests: `testedVersions` is now `["0.1.2"]`, as it already was for ask-user-question and tool-gate.
- `test/fixtures.ts`: `toppingsInput` now uses the recorded multi-select format. The plugin lists numbered options without preview blocks, ends with "Enter the numbers of all that apply, comma-separated (e.g. 1,3), or type an answer of your own.", and sets placeholder `1,3`. The old fixture had invented wording.
- `test/fixtures.ts`: `recordedGateSelect` is the real tool-gate approval payload, tested in `tool-gate.test.ts`.

### Findings and deviations from the plan

- **pi-tool-gate has no manual approval mode.** The plan answers `/approvals` with a manual "default" option, but 0.1.2 offers only `Auto` and `Yolo`. `/gate on|off` maps to the same two modes. In Auto the gate judges each call itself. Offline, with no judge credentials, `cat /etc/hosts` and `rm -rf ./build` were approved without asking (`gate: 1 auto · 0 pushed back · 0 asked`). The offline way to reach the approval prompt is a session ask rule (`/gate rules add <allow|ask|deny> <Tool(specifier)> [--scope session|project|user]`). The test uses that rule and still answers `/approvals` through the generic select.
- **Dialog-opening `/command` prompts.** Pi answers the `prompt` RPC for an extension command only after the command's handler returns. When the handler opens a dialog (as `/approvals`, `/mode`, `/flow` and `/gate rules` do), the host's `session.prompt` stays running. The host therefore routes `session.answer`, `session.abort`, `session.setControl`, `session.adapterAction` and `session.snapshot` through a separate per-session control lane in `CommandRouter`, so the dialog can be answered (and the run stopped) while the prompt waits. The compat test answers `/approvals` through the routed `session.answer` command. Verified.
- **pi-tool-gate statuses.** On every turn it sets `workflow-mode` (`workflow: work (shift+tab to cycle)`), `permission-mode` (`⏵⏵ auto mode on (alt+a to cycle)`), `tool-gate` (`gate: N auto · N pushed back · N asked`) and clears `tool-gate:flow`. The `plan-mode` adapter (loaded with the suite's other adapters) maps `workflow-mode` to its `plan-status` panel, so a session that loads only pi-tool-gate shows a Plan mode panel. pi-tool-gate reads user-level config from `~/.config/agents/tool-gate.json`, and in the project from `.pi/tool-gate.json` or `.pi/tool-gate.local.json`.
- **pi-subagents asks a network classifier** (System 1, `jev`) to pick the agent and thinking level when the call leaves them out. If `TYPESAFE_API_KEY` is in the environment, it does this even with `PI_OFFLINE=1`, and the run records `classifier` and a `system1:decision` entry. The test passes `agent`, `model` and `thinking` explicitly, blanks the key, and asserts that neither record appears.
- **pi-bg ignores `PI_CODING_AGENT_DIR`.** It writes job logs to `~/.pi/agent/bg/<session>/<job>.log`, which is why the harness uses an empty temporary `HOME`.
- **ask-user-question multi-select accepts free text.** Its input also takes "an answer of your own". The adapter's multiselect field has no Other choice, so a typed multi-select answer is not reachable from the form; the user can cancel and answer generically.
- **Isolation gap in plain real-Pi tests.** Without a temporary `HOME`, Pi loads the user's skills from `~/.agents/skills` into the system prompt, even with an isolated `PI_CODING_AGENT_DIR`.
