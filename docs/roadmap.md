# Roadmap

These are the features still planned from the 2026 competitor review (Paseo, Orca, Omnigent, Ovis, Collie, omp-deck). Phase 1 shipped in v0.10.0: session UX. Phase 2 shipped in v0.11.0: live session control.

Each phase below is a scope, not an implementation plan. Before a phase starts, write a detailed plan against the code as it stands then, and check each assumption here against that code.

Each phase ships as one pull request from `dev` to `main`, with one conventional commit per feature. It is reviewed on switchyard-dev, promoted with `scripts/promote.sh`, and released with a version tag (see [development.md](development.md)).

## Phase 3: orchestration, policies and GitHub

PR title: `feat: orchestration, policies and GitHub`. Target release: 0.12.0.

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
  - `model_request` (before a provider call, for cost)
- **Levels:** rules are evaluated per session, then per profile, then server-wide. The first non-ALLOW verdict wins, except that a session-level ALLOW can override a profile-level ASK.
- **Rules:** written in CEL, over `tool.name`, `tool.args`, `session`, `task`, `cost` and `counters`. Built-in rules:
  - **Continuation token and cost caps:** these replace today's caps. Crossing a soft threshold gives ASK. The hard cap gives DENY, but only while the session is on an expensive model.
  - **Destructive commands:** `rm -rf` outside the workspace, `git push --force`, and pushes to the default branch give ASK.
- **Approvals:** an ASK appears as an interaction card, using the existing interaction flow. An approval is stored on the root task, so it covers every subtask.
- **Enforcement:** in the bridge's `tool_call` hook. If the coordinator cannot be reached for 30 s, the hook blocks the tool (fails closed) and tells the user why.
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
- The CEL library choice (bundle size and safety) needs a decision in the detailed plan.
- `gh` may be missing or signed out on a host. Report that as a capability with a reason, not as an error.

## Phase 4: plugin slots, SDK and relay

PR title: `feat: plugin slots, SDK and relay`. Target release: 0.13.0.

### 4.1 Adapter UI slots

Today adapters render only in the Inspector. Phase 4 adds these slots:

| Slot | Where it renders |
|---|---|
| `sidebar.header`, `sidebar.footer` | Navigator header and footer |
| `session.panel` | A tab next to Changes and Details |
| `composer.pill` | A small status pill above the composer |
| `palette.item` | Command palette entries; they plug into the phase 2 registry |
| `slash.command` | A web-handled slash command with an argument form |
| `timeline.renderer` | A custom transcript row for a tool name or custom message type |

Each slot's content is a UI node validated against the existing zod `UINodeSchema`. `webRenderer` iframes stay sandboxed, and there is a mobile fallback text as today.

### 4.2 Version negotiation and client SDK

- **Capabilities in `hello`:** clients announce their capabilities in the WebSocket `hello`. The server sends new message shapes only to clients that announced them, so old PWAs and CLIs keep working.
- **Temporary shims** are tagged `COMPAT(name): remove after YYYY-MM-DD` and listed in `docs/compatibility.md`.
- **`@spencerboucher/switchyard-client`:** a published, typed REST and WebSocket client built from `packages/terminal`'s `SwitchyardClient`. Its API:
  - `sessions.create`, `sessions.send`, `sessions.waitForFinish`, `sessions.transcript`
  - `tasks.create`, `tasks.list`, `tasks.waitForState`
  - `events.subscribe`, with reconnect and cursor resume

  It is documented with examples for scripts and CI.

### 4.3 Optional end-to-end encrypted relay

This is off by default and is the last item; it can be dropped without affecting the rest.

- **Purpose:** reach a coordinator behind NAT through a relay that sees only ciphertext.
- **Handshake:** `Noise_NK_25519_ChaChaPoly_SHA256`. The coordinator's static public key goes after `#` in the pairing URL, so the relay never learns it. Nonces are counters, and the session rekeys every 2^32 messages.
- **Relay:** a small stateless forwarder, which could run in the homelab. The coordinator keeps its normal auth inside the tunnel.

### Phase 4 risks
- Slot content from third-party adapters is untrusted: validate it strictly, and never render HTML outside sandboxed iframes.
- The relay adds a security surface. It needs its own threat model in the detailed plan, or it should be dropped.

## Deferred and not planned

- Server-side speech recognition: dictation stays on the browser's Web Speech API.
- Thumbnails of sent images in the transcript.
- An omp-style context breakdown (system prompt, tools, messages).
- Rewind for RPC-mode sessions: Pi's RPC has no navigate command.
