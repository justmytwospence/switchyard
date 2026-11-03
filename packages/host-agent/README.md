# @switchyard/host-agent

The native host agent. It runs as the owner's OS user, connects outbound to the coordinator (`<coordinatorUrl>/ws/host`), owns the `pi --mode rpc` processes of its sessions, and is the authority for processes, interactions, files and git on this machine.

```ts
import { enroll, runHostAgent } from "@switchyard/host-agent";

await enroll({ coordinatorUrl: "https://sy.example.com", token, name: "laptop" }); // writes host.json
const agent = await runHostAgent(); // reads host.json, opens host.db, connects
// ...
await agent.stop(); // every Pi stopped gracefully (runtime `stopped`), link and DB closed
```

## Files

| Path | Default | Override |
|---|---|---|
| `host.json` (mode 0600): `{coordinatorUrl, hostId, credential, name}` | `~/.config/switchyard/host.json` | `configPath` option, `SWITCHYARD_HOST_CONFIG` |
| State dir: `host.db`, `runtime/` (bridge sockets), `logs/` | `~/Library/Application Support/switchyard` (macOS), `~/.local/state/switchyard` (Linux) | `stateDir` option, `SWITCHYARD_STATE_DIR` |
| Pi binary | `pi` | `piBin` option, `SWITCHYARD_PI_BIN` |

## Modules

| Module | Role |
|---|---|
| `db/` | `node:sqlite` in WAL mode; migrations `001_init` (meta, outbox, receipts, dispatches, sessions, interactions, adapter_state, panels); `tx()` issues `BEGIN IMMEDIATE`/`COMMIT` and runs `afterCommit` hooks |
| `config.ts` | host.json and state-dir paths; `enroll()` (`POST /api/hosts/enroll`) |
| `link.ts` | `CoordinatorLink`: hello, welcome, outbox replay, cumulative acks, reconnect backoff (1, 2, 5, 10, 20, 30 s, +-20% jitter), keepalive |
| `commands.ts` | `CommandRouter`: receipt dedupe, per-session serial queues, `stale_control`, every `HostCommand` |
| `supervisor.ts` | `SessionSupervisor`: one `ManagedSession` per session, adapters, interactions, panels, event mapping, restart recovery |
| `adapters.ts` | `AdapterCatalog`: owner, plugin and bundled (none by default) tiers at startup, project tier (`<workspace>/.switchyard/adapters`) per session |
| `dispatch.ts` | `Dispatcher`: idempotent `dispatch.start` and `dispatch.reconcile` |
| `workspaces.ts`, `git.ts` | worktrees (`<root>/.worktrees/<branch-slug>`), discovery, status, diff, removal, setup streaming; git only through `execFile` |
| `files.ts` | `listDir` / `readWorkspaceFile`, confined to the workspace realpath, 1 MB cap (`too_large`) |
| `checks.ts` | owner-configured check commands (`/bin/sh -c`), 30 min timeout each, 8 KB output tail |
| `main.ts` | `runHostAgent()` wiring and graceful SIGTERM/SIGINT shutdown |

## Delivery guarantees

- **Durable events** (`session.updated`, `transcript.item`, `interaction.updated`, `panel.updated`, `adapters.updated`, `diagnostic`, `workspace.updated`, `workspace.removed`) are inserted into `outbox` inside the same transaction as the state change that caused them, and sent after commit in `hostSeq` order. `hostSeq` is an AUTOINCREMENT key and never reused.
- On `welcome {ackedHostSeq}` every row above the coordinator's ack is replayed in order. `ack {hostSeq}` is cumulative; acked rows are kept 24 h for diagnostics, then pruned. The coordinator also dedupes by `eventId`.
- **Streams** (text, thinking, tool argument and tool output deltas) are ephemeral and only sent while connected.
- **Receipts** are stored by `commandId` before they are sent. A duplicate command (the coordinator re-sends after reconnecting) gets the stored receipt and never runs twice; a duplicate that arrives while the original is still running waits for it.
- **Ordering.** Commands carrying a `sessionId` run one at a time per session, in arrival order (`checks.run` has its own per-session queue so a long check does not block answers). Everything else shares the `host` queue.

## Session events and what the coordinator merges

`session.start` (and `dispatch.start`) do not carry every field of the protocol `Session` entity, so the host emits `session.updated` with the full `Session` shape where the fields it does not own are placeholders:

| Field | Value sent by the host |
|---|---|
| `hostId` | this host's id |
| `workspaceId` | `null` (the host does not know coordinator workspace ids) |
| `projectId` | from `session.start` / `dispatch.start`, else `null` |
| `runId`, `taskId` | from `dispatch.start`, else `null` |
| `connectivity` | `"connected"` |
| `archivedAt` | `null` |
| `provenance` | `created`, or `imported` when the first start already had a native handle |
| `profileSnapshot` | the profile from the start command |

**The coordinator merges only the host-owned fields** into its own row: `title`, `subtitle`, `cwd`, `nativeHandle`, `runtime`, `runtimeDetail`, `queue`, `stats`, `lastAssistantText`, `lastActivityAt`. Everything else in a host `session.updated` is ignored for existing sessions; the placeholders only matter when the coordinator has never seen the session.

When a run settles (`agent_settled`), the single `session.updated` that moves the runtime from `running`/`waiting_input` to `idle` carries an extra key `settled: {aborted, lastAssistantText}`. Token and cost totals (`stats`) follow in a separate `session.updated` once `get_session_stats` answers.

## Interactions

- Pi dialogs (`select`, `confirm`, `input`, `editor`) go through `AdapterSession.onUiRequest`: an adapter claim or the generic renderer becomes an `Interaction` (`pending`, revision 1), persisted before `interaction.updated` is emitted, plus a transcript item of kind `interaction`.
- A dialog answered from an adapter's `queueAnswers` is answered immediately and recorded as `resolved` by `"host"` with the summary "Answered from your earlier form".
- `session.answer` requires `state === "pending"` and a matching `revision`; otherwise it returns `{status: "already_answered", interaction}` and nothing reaches Pi. Answers are serialized per session and per interaction. The response is mapped through the claim (`AdapterSession.respond`) and written with `extension_ui_response`; the interaction becomes `resolved` (or `cancelled`), revision + 1, `resolution.by` = the device id. If the adapter fails while mapping, the interaction is re-shown with the generic form (revision + 1) and the command fails with `conflict`.
- When Pi closes a dialog itself (timeout or abort, reported by the bridge `ui_prompt_end`), a pending interaction becomes `expired` with "Pi closed this question (timeout or abort)".
- `ctx.ui.custom()` (bridge `ui_prompt_start` kind `custom`) creates an `unsupported` interaction with the actions `abort` ("Stop the run", which aborts with `clearQueue`) and `message` ("Send a message to the agent"). The coordinator raises the `unsupported_interaction` attention from the interaction state.
- Fire-and-forget requests: `notify` becomes a notice item; `setStatus` and `setWidget` go to adapter hooks and then the generic panels (`adapterId: "generic"`, slots `status` and `widget:<key>`); `setTitle` sets `subtitle`; `set_editor_text` becomes a `system` item `{text, suggestion: true}`.
- Adapter `attention(reason, summary)` calls are reported as a `diagnostic` event with an extra `attention: {reason, summary}` key, because hosts cannot emit attention events.

## Command results

| Command | Result |
|---|---|
| `session.start` | `{sessionId, nativeHandle, workspacePath, runtime, reused}` |
| `session.prompt` | `{disposition}` |
| `session.abort` | `{cleared: {steering, followUp} \| null}` |
| `session.stop` | `{runtime}` |
| `session.answer` | `AnswerResult` |
| `session.setControl` | `{controlRevision, controlMode}` (an older revision never rolls control back) |
| `session.rename` | `{title}` |
| `session.importable` | `{sessions: ImportableSession[]}` |
| `session.readNative` | `{sessionId, cwd, name, items}` |
| `session.snapshot` | `SnapshotResult` plus `runtime` |
| `session.models` | `{models: SessionModel[]}` |
| `session.commands` | `{commands: SlashCommand[]}` |
| `session.setModel` | `{model, thinking}` |
| `session.setThinking` | `{model, thinking}` |
| `session.compact` | `{ok: true}` (progress via `session.updated` `compacting`) |
| `checkout.inspect` | `CheckoutInfo` |
| `workspace.discover` | `{worktrees: DiscoveredWorktree[]}` |
| `workspace.create` | `{path, branch, baseBranch, provenance, git, setup}`; setup output streams as `workspace.updated {path, setup}` |
| `workspace.status` | `{path, git}` |
| `workspace.remove` | `{ok: true, path}` and a `workspace.removed {id: path, path}` event |
| `workspace.diff` | `DiffResult` |
| `workspace.files` | `{dir, entries: FileEntry[]}` |
| `workspace.readFile` | `{path, size, encoding: "utf8" \| "base64", content, binary}` |
| `dispatch.start` | `DispatchStartResult` |
| `dispatch.reconcile` | `ReconcileResult` |
| `checks.run` | `ChecksResult` |

## Control revisions

An `origin: "automation"` `session.prompt` fails with `stale_control` when its `controlRevision` is below the stored one, or equal to it while the stored mode is `human`. `session.setControl` stores the revision and mode. Human prompts are never rejected for control reasons.

## Dispatch idempotency

`dispatch.start` inserts the `dispatches` row (`accepted`) before any side effect, then creates the worktree and waits for its setup (`workspace_ready`), then starts Pi with the prompt (`started`, outcome stored). A duplicate returns the stored outcome with `reused: true`, or the stored error; it never creates a second worktree or process. A dispatch interrupted by a host-agent crash becomes `failed` ("Host agent restarted during dispatch") and is never replayed.

## Restart behaviour

Pi children are not detached, so they die with the agent. On start, sessions recorded as `starting`, `running`, `idle` or `waiting_input` become `interrupted` (native handle kept) with a notice "Host agent restarted; resume to continue", and their pending interactions expire. Nothing is resumed or replayed automatically; `session.start` with the native handle resumes.

## Test hooks

`runHostAgent({testHooks: {dropReceipt(commandId, command), onCommand(command)}})`: `dropReceipt` returning true stores the receipt but does not send it (a lost receipt); `onCommand` sees every command including duplicates. `agent.spawnedPiProcesses` counts Pi processes, `agent.router.commandLog` records every command with its outcome, `extraExtensions` adds `-e` extensions (the test fixture), and `env` passes `PI_CODING_AGENT_DIR` and friends to Pi.

## Tests

`pnpm exec vitest run --project host-agent`. The session tests use the real installed Pi with the scripted mock model from `@switchyard/test-fixtures` and a fake coordinator (a `ws` server speaking the host protocol).
