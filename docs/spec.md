# Pi Workspace: V1 Product and Implementation Specification

## 1. Product contract

Build a self-hosted Pi metaharness that combines interactive coding, remote execution, plugin interfaces, and scheduled background work.

One persistent session must be accessible from terminal, desktop web, and mobile PWA. A task card, notification, and conversation must reference the same work.

The primary acceptance journey:

> Create a task on the phone. The coordinator dispatches it to a host, creates a repo-local worktree, and starts Pi with extensions. A plugin asks a question. Answer on desktop; all clients reflect the answer. Attach from terminal, take over, then return the session to automation. The task finishes into Review. A notification opens the result. Restarting the coordinator never duplicates the run.

This is an implementation specification, not a mockup brief. Build real persistence, execution, synchronization, and failure handling.

## 2. Inspiration map and boundaries

Sources establish precedents. Requirements below define this product's behavior. Do not assume a source implements features beyond what is specifically identified.

Before implementation, record the source revision or documentation access date used. Do not depend blindly on moving upstream branches.

| Source                                                                                                                       | Specific precedent                                                                                       | Adopt in this product                                                                  | Deliberate boundary                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Pi Agent Dashboard integration](https://github.com/BlackBeltTechnology/pi-flows/blob/develop/docs/dashboard-integration.md) | Server-owned plugin state and serialized `IntentNode` UI trees                                           | Server-authoritative adapter state; portable components rendered on all clients        | Do not assume arbitrary terminal UI is automatically convertible                          |
| [Paseo provider contract](https://github.com/getpaseo/paseo/blob/main/docs/providers.md)                                     | Pi process-backed RPC; bridging select/input/editor/confirm; native session imports                      | Explicit runtime capabilities, supported interaction bridging, native session identity | Build a Pi-focused integration rather than copying a multi-provider abstraction wholesale |
| [Paseo orchestration](https://paseo.sh/docs/orchestration)                                                                   | Agents managed by ID, remote hosts, profiles, fresh scheduled sessions, continuing heartbeats            | Stable session addressing; distinguish new scheduled work from continuation            | Do not expose every orchestration capability as unconstrained agent authority             |
| [Paradev tasks](https://docs.paradev.com/tasks)                                                                              | Task management connected to agent workspaces                                                            | Tasks launch or reference ordinary coding workspaces                                   | A board is a view of task state, not the execution engine                                 |
| [Paradev automations](https://docs.paradev.com/automations)                                                                  | Schedule/event-triggered runs produce live workspaces users can continue                                 | Automated and interactive work use the same workspace/session model                    | V1 supports simple rules, not a broad external integration marketplace                    |
| [OpenChamber](https://github.com/openchamber/openchamber)                                                                    | Cross-device projects/sessions, review, server-side goals, scheduling                                    | Coding view with conversation and changes; reconnectable work; bounded continuation    | Multi-model races, Fusion, and browser-design tools are deferred                          |
| [OpenChamber goals](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/session-goals.mdx)       | Goal execution continues server-side and has pause/resume and limits                                     | Explicit continuation policy, visible budget, takeover distinct from stop              | An agent/auditor claim is not sufficient proof that a task passed acceptance              |
| [Orca mobile](https://www.onorca.dev/docs/mobile)                                                                            | Structured mobile chat, questions, files, source control, workspace/agent creation                       | Mobile is an actionable coding surface, including review                               | Raw terminal emulation is not the primary phone experience                                |
| [Omnigent mobile](https://omnigent.ai/docs/interact/mobile)                                                                  | Terminal/browser/phone access to shared sessions and a configured server                                 | Device-independent session access and central discovery                                | No requirement to adopt its agent runtime or policy system                                |
| [Pi plugin suite](https://github.com/justmytwospence/pi-plugins)                                                             | Existing questions, planning, tool gates, subagents, background work, review and terminal customizations | Real compatibility fixtures and prioritized adapter coverage                           | No blanket compatibility claim without testing                                            |
| Agent host containers (common self-hosting practice) | Execution against actual host development environments | Native host agents with local credentials/configuration | Coordinator containers do not need the host home or Docker socket |
| Repository-contained worktree convention                                        | Repo-contained worktrees and coexistence with other tools                                                | `<repo>/.worktrees/<branch-slug>` plus discovery                                       | No central hidden worktree directory                                                      |
| [Web Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)         | Tags and notification click handling                                                                     | Session-keyed notification replacement and deep links                                  | OS delivery and removal remain best effort                                                |
| [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)                                    | Home Screen PWA push and user permission                                                                 | Explicit mobile notification onboarding                                                | No guaranteed silent background processing                                                |
| [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)                                      | Separate durable task/extension architecture                                                             | Reserve room for a future runtime implementation                                       | No v1 integration or ordinary-plugin compatibility promise                                |

Herdr supplies the workflow concept of repository/worktree grouping and persistent session navigation. Treat that as an owner requirement, not an assertion about Herdr's internal architecture.

Vibe Kanban is a historical board-oriented precedent, not a deployment dependency. Its [shutdown announcement](https://vibekanban.com/blog/shutdown) makes lifecycle ownership particularly relevant.

## 3. Scope and fixed decisions

### Required

- Standalone and hub-connected operation.
- Native macOS/Linux host agents.
- Docker Compose coordinator.
- Responsive web/PWA, terminal client, scriptable CLI.
- Single sign-on and passkey sign-in, browser-approved terminals, device revocation.
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

| Entity         | Essential fields                                                               |
| -------------- | ------------------------------------------------------------------------------ |
| Project        | ID, name, repository identity, profiles, workspace/concurrency defaults        |
| Checkout       | Project, host, absolute clone path, Git common-directory identity              |
| Workspace      | Checkout, path, branch/base, managed/discovered provenance, Git state          |
| Session        | Native handle, host/workspace, profile snapshot, runtime state, linked run     |
| Task           | Objective, acceptance criteria, project, dependencies, priority, state, policy |
| Run            | Task/session, dispatch key, attempt, limits, control revision, outcome         |
| Automation     | Trigger, filters, task template, grouping/overlap/missed-run policy            |
| Interaction    | Session, ID/revision, payload, allowed responses, resolution                   |
| Attention item | Session/task, reason, severity, acknowledgment                                 |
| Device         | Identity, credentials, presence, push subscription, revocation                 |

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

Layouts, chosen from View options (persisted per device):

- **Projects** (default on desktop): project → sessions. Each row shows host (or the project header does, when all its sessions share one) and branch unless it is the main checkout.
- **Worktrees**: project → workspace → sessions. A project whose only workspace is the main checkout is shown without the workspace level.
- **Recent**: one list, sessions needing input first, then by last activity, with project, host and branch on each row.
- **Hosts**: host (with connection state) → project → sessions.

Subagent sessions are hidden unless "Show subagents" is on. Within a group, sessions needing input come first. Session rows show title, textual status, last activity, and attention indicator.

Provide search, active/all filter, view options, collapse controls, and New session.

Empty state: "Add a project" and "Connect a host," based on what is missing.

New session flow: prompt first ("What should Pi do?", optional), then Project, Workspace (default: the main checkout on an online host; "New worktree…" suggests a branch from the prompt), Host (only when the project has checkouts on several hosts) and Pi profile (project default). Advanced: session title and checkout. Show the resulting branch/path above Create; Cmd/Ctrl+Enter creates. Do not require a task.

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

Pending interactions appear inline and in a persistent "Needs input" strip linking to the first unanswered item.

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

Same layouts as the desktop navigator; defaults to Recent. Status filters and search.

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

Host detail shows capabilities, connectivity, project folders, checkout mappings, and version compatibility. Every Git repository directly inside a host's project folders becomes a project (or another checkout of the project with the same remote): scanned when the folders change, when the host connects, every 10 minutes and on demand; nothing is removed automatically.

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

Single sign-on (required off localhost) or passkeys for browsers; terminals approved from a signed-in browser. Separate revocable device credentials. Separate host enrollment.

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
