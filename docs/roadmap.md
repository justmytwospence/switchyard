# Roadmap

This roadmap tracks the 2026 competitor review (Paseo, Orca, Omnigent, Ovis, Collie, omp-deck). Phase 1 shipped in v0.10.0 (session UX), phase 2 in v0.11.0 (live session control), and phase 3 in v0.12.0 (orchestration, policies and GitHub). Phase 4 shipped in v0.13.0; v0.14.0 adds the reviewed plugin-development workflow and keyboard navigation. v0.15.0 adds GitHub trackers, per-project worktree rules and Pi sessions you start yourself ([scopes.md](scopes.md), [terminal-sessions.md](terminal-sessions.md#sessions-you-start-yourself)). v0.16.0 explains views and filters the Board by them, manages trackers in Settings, lets a tracker include repositories of other owners, and files sessions in worktrees Switchyard had not seen yet. v0.17.0 lists a worktree's commits in the Changes tab and diffs one commit at a time. v0.18.0 makes branches the unit of work ([model.md](model.md)): one primary session per branch, trackers that follow issues or a whole board without creating tasks, and a branch Board. It also lets a tracker only watch, archives ended sessions a branch has moved past, supports Pi 1.6, and stops ticking status panels from flooding the event log. v0.21.0 renames the vocabulary: views and trackers become [scopes](scopes.md), herdr and tmux sessions become [clients](clients.md), "terminal" means only a [terminal session](terminal-sessions.md), and the herdr and tmux plugins are client modules under `modules/`.

Each phase below is a scope, not an implementation plan. Before a phase starts, write a detailed plan against the code as it stands then, and check each assumption here against that code. Feature placement and failure behavior follow the [core/plugin ownership contract](plugin-boundaries.md).

Each phase is reviewed on the dev deployment before promotion of `dev` to `main` with `scripts/promote.sh`; production releases use a version tag (see [development.md](development.md)).

## Evolving Pi plugins: v0.14.0

The current source implements session-scoped, trust-aware Pi resource discovery, target entrypoint and component-version matching, idle-only adapter refresh with generation fencing, presentation-only restore, and a portable UI preview. Native Pi reload confirmation and safe adapter refresh are distinct from browser refresh. See [adapters.md](adapters.md), [development.md](development.md#adapter-development-and-cross-repository-checks), and [compatibility.md](compatibility.md#adapter-development-compatibility-dev-tranche). This translates explicit plugin contracts, not arbitrary TUIs; runtime helper imports are not promised hot reload.

The build, lint, full unit/integration suite, four-viewport browser suite and packaged CLI/client smoke checks pass. The three-version compatibility matrix and the first core dev deployment also pass. Managed plugin rollout, paired deployment and live phone verification are tracked separately in [acceptance-report.md](acceptance-report.md#current-dev-tranche-automated-verification); historical results below do not establish them. Production promotion uses the reviewed release process below.

## Phase 3: orchestration, policies and GitHub

Released in v0.12.0. The approved plan deferred pre-provider `model_request` enforcement. See [policies.md](policies.md) and [github.md](github.md).

### 3.1 Agent tools

The bridge extension registers three Pi tools, so a session can start and coordinate other work:

- **`switchyard_create_task`** creates a task from inside a session. Its arguments are:
  - `objective`
  - `acceptance` (a list)
  - `dependencies` (task ids)
  - `parentTaskId`, which defaults to the calling session's task
  - `hostId` and `profileId` hints
  - `notifyOnFinish` (boolean, default true)
- **`switchyard_send`** sends a message to another session, as `steer` or `queue`.
- **`switchyard_inbox`** reads messages addressed to this session.

How the tools behave:
- **Idempotency:** every call that changes something carries an idempotency key, the tool-call id. A retried call returns the first result instead of creating a second task or message.
- **Delivery:** messages arrive as a short header line that points at the inbox, not as the full body.
- **Holding:** a message is held while the target's terminal editor has a draft (`ctx.ui.getEditorText()` is not empty) or while a dialog is open. It waits at most 10 minutes, then is delivered as queued.
- **Limits:** messages are rate-limited per session pair, and a reply chain has a maximum depth (default 4), so agents cannot loop.
- **Permissions:** the coordinator checks every call against the session's control mode. A session under human control can still use the tools; the policy engine (3.3) decides.

### 3.2 Subtasks and finish notifications

- **Parent tasks:** `Task.parentTaskId` (optional), with a guard against cycles. The board shows subtasks nested under their parent, with a done/total count on the parent card.
- **Subscriptions:** each `{child, parent}` pair is stored in SQLite and survives restarts. When the child reaches Review, Done or Failed, the parent session gets a tagged system message containing:
  - the child's title and final state;
  - its last reply, cut to 4,000 characters;
  - the ids of any open permission requests.
- **Delivery:** finish notifications use the same hold rules as 3.1. A notice is delivered at most once (it has a unique key per child and state).

### 3.3 Policy engine

- **Verdicts:** `ALLOW`, `ASK` or `DENY`, optionally with `state_updates` that carry counters between evaluations.
- **Phases:**
  - `tool_call` (before Pi runs a tool)
  - `request` (a Switchyard API action by an agent)
  - `model_request` (before a provider call): deferred, not enforced
- **Levels:** rules are evaluated per session, then per profile, then server-wide. The first non-ALLOW verdict wins, except that a session-level ALLOW can override a profile-level ASK.
- **Rules:** written in CEL, over `tool.name`, `tool.args`, `session`, `task`, `cost` and `counters`. Built-in rules:
  - **Continuation token and cost caps:** these replace today's caps. Crossing a soft threshold gives ASK. The hard cap gives DENY, but only while the session is on an expensive model.
  - **Destructive commands:** `rm -rf` outside the workspace, `git push --force`, and pushes to the default branch give ASK.
- **Approvals:** an ASK appears as an interaction card. A root-task grant is shared only for the same rule revision and normalized action fingerprint, not as blanket approval for the task tree.
- **Enforcement:** the bridge's `tool_call` hook and agent request boundaries fail closed. If the coordinator cannot be reached for 30 s, the hook blocks the tool. Budgets are checked before automated continuations, not during a running turn.
- **Settings:** "Policies" in Settings lists the built-in and custom rules. A rule tester runs a sample tool call through the rules and shows the verdict.

### 3.4 GitHub through `gh`

All GitHub access runs through the `gh` CLI on the host, with the user's own login. The coordinator stores no GitHub tokens.

- **PR panel:** an Inspector tab for workspaces with a pull request. It shows:
  - checks, with status and links;
  - review threads;
  - merge state.

  Merge is guarded by the expected head commit, so it never merges a commit the user has not seen.
- **Refresh:** when a session goes from active to idle, plus a 60 s poll while the panel is open.
- **PR detection:** a PR is found from `git push` output (the URL GitHub prints), and with `gh pr view` for the branch.
- **"Send failing CI to the agent":** sends the last 150 log lines of each failed job, fenced and marked as untrusted. The prompt asks the agent to classify each failure (real, flaky, or infrastructure) before fixing anything.
- **"Resolve review comments":** sends the open threads. The agent fixes the code; it does not resolve threads and does not commit unless asked.
- **Tasks from issues:** paste an issue URL to create a task. The launch prompt is only the link plus "read it with `gh issue view`"; the agent fetches the content itself.

### Phase 3 risks
- Changes to the host wire must stay compatible with hosts one release behind. New host commands should check for a capability.
- CEL evaluation must stay bounded and fail closed on errors.
- `gh` may be missing or signed out on a host. Report that as a capability with a reason, not as an error.

## Phase 4: adapter UI slots and client SDK

The adapter slots and capability negotiation shipped in v0.13.0. The typed Node SDK accompanies the v0.14.0 release; first publication requires its own npm trusted-publisher setup. The optional relay remains deferred.

### 4.1 Adapter UI slots

Legacy adapter panels render in Extensions. Phase 4 adds these session-scoped placements:

| Slot | Where it renders |
|---|---|
| `sidebar.header`, `sidebar.footer` | Navigator header and footer |
| `session.panel` | A tab next to Changes and Details |
| `composer.pill` | A small status pill above the composer |
| `palette.item` | Command palette entries; they plug into the phase 2 registry |
| `slash.command` | A namespaced web-handled slash command with a portable argument form |
| `timeline.renderer` | Host-side tool cards and custom-message notice cards, with readable text fallbacks |

Each slot's content is a UI node validated against the existing zod `UINodeSchema`. `webRenderer` iframes stay sandboxed, and there is a mobile fallback text as today.

### 4.2 Version negotiation and client SDK

- **Capabilities in `hello`:** clients announce their capabilities in the WebSocket `hello`. The server sends new message shapes only to clients that announced them, so old PWAs and CLIs keep working.
- **Temporary shims** are tagged `COMPAT(name): remove after YYYY-MM-DD` and listed in `docs/compatibility.md`.
- **`@spencerboucher/switchyard-client`:** a typed Node REST and WebSocket client prepared for publication, sharing the connection and store extracted from `packages/terminal`. Its API:
  - `sessions.create`, `sessions.send`, `sessions.waitForFinish`, `sessions.transcript`
  - `tasks.create`, `tasks.list`, `tasks.waitForState`
  - `events.subscribe`, with reconnect and cursor resume

  It is documented with examples for scripts and CI.

### 4.3 Optional end-to-end encrypted relay (deferred)

Spencer chose to defer the relay. This is not part of the Phase 4 implementation or the v0.13.0 dev review; it requires a separate threat model and explicit authorization.

- **Purpose:** reach a coordinator behind NAT through a relay that sees only ciphertext.
- **Handshake:** `Noise_NK_25519_ChaChaPoly_SHA256`. The coordinator's static public key goes after `#` in the pairing URL, so the relay never learns it. Nonces are counters, and the session rekeys every 2^32 messages.
- **Relay:** a small stateless forwarder, which could run in the homelab. The coordinator keeps its normal auth inside the tunnel.

### Phase 4 risks
- Slot content from third-party adapters is untrusted: validate it strictly, and never render HTML outside sandboxed iframes.
- The deferred relay adds a security surface. It requires a separate threat model and explicit approval before implementation.

## Session experience: the 2026-11 review

A review of the session UI against Ovis, Collie, Paseo, T3 Code, opencode, Orca, Omnigent, pi-agent-dashboard and the Claude, Codex, Cursor and Conductor apps (revisions pinned in [sources.md](sources.md)) found one shape they share and Switchyard lacks: the transcript is a quiet document, everything live sits at the composer, and plugins describe what a thing is instead of shipping an opaque card.

Principles:

1. The transcript is a document, not a log.
2. One thing, one place.
3. Live and ambient state lives at the composer.
4. No state moves content.
5. The phone is a first-class supervision surface: thumb-reachable answers, sheets for detail, one row of composer controls.
6. Plugins declare meaning, core renders it.
7. Quiet by default, colour only for state.
8. Nothing is shown as done without evidence.

Each phase ships and is reviewed on a deployment on its own. A phase is a scope; its file-level plan is written when it starts.

- **S1 Transcript** (on `dev` since 2026-11-26, web only). One line per tool call with typed detail; unboxed messages; a turn fold with a sentence summary; Tool activity Detailed / Normal / Summary.
- **S2 Request dock and composer** (on `dev` since 2026-11-26, web only). A pending question, approval or plan answer is docked above the input, not in the transcript; the transcript keeps one outcome line where it happened. A plan keeps its reader in the transcript column and its answers in the dock; a form with several questions gets step chips. The "Needs input" strip goes. The input is one card with one row: a `+` menu, mic, the model and effort pills, a context ring that opens context, tokens, cost, subscription limits and Compact, and one round button (Send when idle, Stop when running with an empty draft, Send with a small Stop beside it when running with a draft). A per-device setting chooses what Send does while Pi works (Queue, the default, or Steer); Cmd/Ctrl+Enter or the `+` menu does the other. Queued messages are listed above the input. A suggested next message is a chip in the card. A tracker row above the input holds a Changes pill and the adapters' pills.
- **S2b Session chrome** (on `dev` since 2026-11-26, web only). The desktop header is one row: title, status, then branch, host, issue and project as the width allows. On a phone the tab strip is gone: the chat fills the screen, a header button with the changed-file count opens Changes, PR and Details as one panel over the chat, and Terminal opens from the overflow menu. The panel is a history entry, so Back returns to the chat. Site screenshots are regenerated once, after S5.
- **S3 Adapter contract v2** (on `dev` since 2026-11-26; protocol, adapter-sdk, host-agent, coordinator, web). `describeTool` lives in `@switchyard/protocol`; the host adds what Pi's result says (an edit's real diff, a failed command's exit code) and an adapter's `toolView(tool, ctx)` (kind, verbs, target, counts, a detail node, `hide`) goes on top; `toolCard` stays as the legacy form. New nodes `checklist`, `facts`, `rows` and `badge`, `section.open`, and a `url` ref. New placements `composer.tracker` (title, count, status, current step, detail node) and `session.badge` (carried to the web store; S5 draws it); `composer.pill` is unchanged. `Claim.kind` and `Interaction.kind` and `toolCallId`: a question hides its tool call's row and takes number keys, an approval does neither. `session.clearQueue` and Edit queue. Unclaimed statuses are one Status tracker. Negotiation: host feature `adapterContract.v2` and client capabilities `tool.views.v1`, `ui.nodes.v2` and `adapter.trackers.v1`, with the host and the coordinator each sending version 1 shapes to a peer that did not ask for more; adapters read `ctx.features`. The contract as one type file: `packages/adapter-sdk/src/contract.ts`.
- **S4 pi-plugins adapters on v2** (pi-plugins). ask-user-question: a dock form with step chips, the tool row hidden, an outcome line. tool-gate: an approval as facts plus the command, structured from a plugin-published entry instead of title parsing, and a mode tracker. plan-mode: the reader plus dock answers, and a Plan tracker. todo: a checklist tracker (`Todo 2/5 · current step`) and grouped update rows. subagents and bg: trackers with rows (name, status, elapsed, open link), verbs for their tools, and structured job data instead of status-text parsing. Small tool-view adapters for next-prompt, issues, ship, herdr and system1.
- **S5 Navigator and attention** (on `dev` since 2026-11-26, web only). A session row is a status mark, the title and the time, then its context, the adapters' `session.badge` words and a one-line preview (the pending question, the failure, else the first line of the last reply, all from fields the client already has). The Extensions tab is gone: extension panels and an Extensions line with the adapter diagnostics are in Details. On the Attention page a pending question looks as it does in the dock. The site screenshots are regenerated once S4 has landed too.

Ownership ([plugin-boundaries.md](plugin-boundaries.md)): Pi and plugins stay the authority for workflows; tool views, trackers and badges are presentation derived by the host or an adapter and cached by the coordinator. With an adapter absent or failed, core shows the generic row (tool name, first argument, arguments and output), generic dialogs in the dock and unclaimed statuses in the Status tracker; nothing is answered automatically. Web and coordinator never branch on a plugin or adapter id; verbs exist only for Pi's own built-in tools.

## Deferred and not planned

- Server-side speech recognition: dictation stays on the browser's Web Speech API.
- Thumbnails of sent images in the transcript.
- An omp-style context breakdown (system prompt, tools, messages).
- Rewind for RPC-mode sessions: Pi's RPC has no navigate command.
