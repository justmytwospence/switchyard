# Adapters

Pi extensions talk to their user through `ctx.ui` dialogs, status entries, widgets, custom messages and tool results. In RPC mode those arrive at the host agent as plain payloads that do not say which extension sent them. An adapter recognizes one extension's payloads and turns them into portable UI: tool cards, forms, panels, subagent links and attention items, rendered the same way on the web, phone and terminal.

Adapters run in the host agent (`@switchyard/adapter-sdk`). They are trusted, installed code and are not sandboxed. Only their optional web renderer runs in an isolated frame. They translate plugin semantics, not arbitrary custom TUIs or plugin workflows; see the [ownership contract](plugin-boundaries.md).

## Manifest

Every adapter is a directory with a `switchyard-adapter.json`:

```json
{
  "id": "hello",
  "version": "0.1.0",
  "target": {
    "extension": "pi-hello",
    "versionRange": ">=0.1.0 <1.0.0",
    "testedVersions": ["0.1.0"]
  },
  "protocolVersion": 1,
  "server": "server.js",
  "webRenderer": null,
  "capabilities": ["toolCards", "panels", "progress"]
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, `.`, `_`, `-`. A higher tier with the same id replaces a lower one. |
| `version` | The adapter's own version. |
| `target.extension` | The Pi package the adapter understands. |
| `target.versionRange` | Semver range of that package. When the installed version is outside it, the adapter stays active, Settings shows a warning, and unmatched dialogs fall back to generic. |
| `target.testedVersions` | Versions recorded as tested by the adapter author. |
| `target.entrypoints` | Optional nonempty list of relative extension paths within the target component package root. The host requires an enabled, runtime-reported match; absolute paths and traversal outside the root are rejected. |
| `protocolVersion` | Must be `1`. |
| `server` | ESM module, relative to the manifest, whose default export is a `ServerAdapter` or a factory `({manifest, dir}) => ServerAdapter`. A `.ts` file works too: Node (24 or later) strips its types on import, so it may use only erasable syntax (see [Shipping an adapter with your Pi package](#shipping-an-adapter-with-your-pi-package)). |
| `webRenderer` | Relative path to an HTML file for the custom web renderer, or `null`. |
| `capabilities` | Informational: any of `toolCards`, `interactions`, `panels`, `progress`, `subagents`, `attention`, `state`, shown in Settings › Adapters and session details. The host does not enforce them. `commands` is retired: accepted and ignored. |

`parseManifest()` and `loadManifest()` validate it and list every problem. Unknown keys are rejected.

## Precedence and discovery

Adapters are consulted in this order:

1. **Project:** `<project root>/.switchyard/adapters/<name>/switchyard-adapter.json`.
2. **Owner:** `~/.config/switchyard/adapters/<name>/switchyard-adapter.json`.
3. **Plugin:** enabled Pi packages whose `package.json` declares `"switchyard": {"adapter": "<dir>"}` (a path or list). Discovery is per session: a read-only helper uses the installed Pi resolver for user settings and, only when Pi confirms project trust, project `.pi/settings.json`, including Pi's resource filters and autoload deltas. It does not install or update packages. The running bridge reports extension paths from registered tools and commands; this is not a complete loaded-extension inventory. An adapter declaring `target.entrypoints` requires an enabled path also reported by the runtime; otherwise it is disabled without import. Legacy manifests use coarser enabled provider-package matching. The target component's matching `package.json`, not necessarily the suite provider's, supplies its version.
4. **Bundled:** adapters the embedding code passes in (`AdapterCatalog`'s `bundled` option). The host agent bundles none: adapters ship with the Pi packages that own them.
5. **Generic renderer** for anything no adapter handles.

Within a tier, adapter directories load in name order. When two tiers provide the same `id`, only the higher one is active; the other is listed as disabled. Project-tier code requires confirmed trust and an available inventory. Unknown trust or resolver failure falls back conservatively to owner adapters and legacy user-scope discovery, with diagnostics; no speculative project code is imported. Vanilla and `--no-extensions` skip plugin adapters. UI-only extensions may need explicit owner or trusted project adapters because Pi does not expose a complete extension inventory.

## Shipping an adapter with your Pi package

The usual home for an adapter is the Pi package whose extension it understands, so the two change and version together. Put the adapter directory (manifest plus server module) anywhere in the package and list it in the package's `package.json`:

```json
{
  "name": "pi-hello",
  "pi": { "extensions": ["./src/index.ts"] },
  "switchyard": { "adapter": "./src/switchyard" }
}
```

`switchyard.adapter` is a path or a list of paths relative to the provider package root, so a suite can declare one adapter per component. An installed package contributes eligible adapters through the plugin tier according to the session's effective Pi resources and trust; installation alone does not enable every component. Nothing is installed into Switchyard.

The server module may be TypeScript (`"server": "adapter.ts"`), loaded with Node's built-in type stripping:

- **Erasable syntax only:** type annotations, interfaces, type aliases, `as` and `satisfies`, and `import type`. No `enum`, `namespace`, parameter properties or other syntax that needs code generation.
- **No runtime imports.** The `@switchyard/*` packages are not published, and Pi packages should not depend on Switchyard. Declare the few types the adapter needs (`UINode`, `Claim`, `AdapterContext`, ...) locally, copied structurally from `@switchyard/protocol` and `@switchyard/adapter-sdk`, and build nodes and claims as plain objects.
- **Not inside `node_modules`.** Node refuses to strip types there. Git and local installs live outside it (`<agentDir>/git/<host>/<path>`); an npm install of a package with a `.ts` adapter fails to load, and the host reports the load error as a diagnostic in Settings > Adapters. Ship compiled `.js` if the package is installed from npm.

The real-world example is [pi-plugins](https://github.com/justmytwospence/pi-plugins): each package keeps its adapter in `packages/<pkg>/src/switchyard/{adapter.ts, switchyard-adapter.json}` with a test beside the package's other tests, and the root `package.json` lists all of them in `switchyard.adapter`. Switchyard's compatibility tests (`packages/host-agent/test/compat/`) load that suite through the plugin tier against real Pi (see [compatibility.md](compatibility.md#plugin-compatibility)).

## Hooks

```ts
interface ServerAdapter {
  toolCard?(tool, ctx): UINode | undefined;
  toolView?(tool, ctx): ToolViewData | undefined; // contract v2
  customMessageCard?(message, ctx): UINode | undefined;
  claimInteraction?(req: PiUiRequest, ctx): Claim | undefined;
  onToolStart?(e, ctx); onToolUpdate?(e, ctx); onToolEnd?(e, ctx);
  onEntry?(entry, ctx); onCustomMessage?(m, ctx);
  onStatus?(key, text | undefined, ctx); onWidget?(key, lines | undefined, ctx);
  onAction?(actionId, payload, ctx);
  onRestore?(ctx);
}
```

Every hook is optional and may be async. The host calls them in precedence order:

- `toolCard`, `toolView`, `customMessageCard` and `claimInteraction`: the first valid result in precedence order wins.
- Observation hooks (`onToolStart`, `onToolUpdate`, `onToolEnd`, `onEntry`, `onCustomMessage`, `onStatus`, `onWidget`): every adapter is called. `onToolUpdate` gets each `tool_execution_update` with the partial result and its `details`. `onStatus` and `onWidget` may return `true` to say they presented the value: the host then leaves that status key out of the generic Status panel, or removes the generic `widget:<key>` panel. Return nothing (or `false`) to keep the generic presentation; if the adapter is later disabled, the key's next update shows in the generic panel again.
- `onAction`: only the adapter named in the action.

`onRestore` runs on a new adapter context to rebuild presentation from persisted state. It can read and write state and publish panels or contributions; attention, subagent links and queued answers are refused. It does not replay historical tool hooks, approvals, messages or execution. Effects are buffered until the candidate context is committed; failed or retired candidates cannot publish late effects.

**Failure isolation.** Each call runs inside try/catch with a 2 s timeout. A throw, a timeout, or an invalid result (a card or claim that fails `validateUINode`, a response that does not fit the dialog) disables that adapter for the rest of the session and emits an error diagnostic. The caller then falls back to generic. Nothing is ever answered automatically: a failed claim becomes the generic form, and the Pi call stays blocked until a human answers it.

### Context

Each adapter gets its own context per session:

| Member | Purpose |
|---|---|
| `sessionId`, `adapterId` | Identity. |
| `state.get/set/delete/keys` | Server-authoritative JSON state, persisted by the host and restored when the session reopens. |
| `setPanel(slot, node \| null, {title?, mobileFallback?, state?})` | Create, update or clear a legacy panel. `state` is passed to the web renderer. |
| `setContribution(id, contribution \| null)` | Create or update a typed, session-scoped contribution, or remove an owned contribution. |
| `attention(reason, summary)` | Raise a semantic attention item. |
| `linkSubagent({runId, label, status, sessionFile})` | Show a subagent run, linked to a read-only view of its session file. |
| `queueAnswers(matcher, responses, {toolCallId?})` | Pre-answer later dialogs of the same tool call (see below). |
| `log(level, message)` | Adapter log line. |

### Session contributions

`setContribution` adds portable UI to the current session, not globally to the host. Even navigator and palette entries belong only to the selected session; selecting another session or none removes them from those surfaces. Contributions sort by `order` (default `0`), then adapter ID, then contribution ID. For example:

```ts
ctx.setContribution("build", {
  placement: "sidebar.header",
  title: "Build",
  node: { t: "text", text: "Building" },
  mobileFallback: "Building",
  order: 10,
});
ctx.setContribution("build", null); // remove it
```

| Placement | Web presentation and requirements |
|---|---|
| `sidebar.header`, `sidebar.footer` | Portable content above or below the selected session's navigator body. Areas scroll when full. |
| `session.panel` | Inspector tab; may use the adapter's custom renderer on desktop. Only this placement accepts renderer `state`. |
| `composer.pill` | Compact, non-interactive text or progress root node; no `actionId`. The title remains available when the display is truncated. |
| `palette.item` | An Extensions palette entry; requires `actionId`, optionally `keywords`. Selection previews the portable node with interactions disabled; Run invokes the action. |
| `slash.command` | Requires `actionId`, a root `form` node and a `name` matching `[a-z][a-z0-9-]{0,39}`. Its name is always `/adapter:<adapterId>:<name>`. It opens a form, not a Pi prompt. |

All contributions require a nonempty `title` (at most 100 characters), a portable `node`, and a nonempty `mobileFallback` (at most 2,000 characters). IDs match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}`. `order`, if supplied, is an integer from -1000 to 1000. An `actionId` is 1–200 characters and is required for nodes containing a form or confirm. Palette keywords are limited to 20 nonempty strings of at most 80 characters each. Contribution objects reject unknown fields. There may be at most 64 active contributions per adapter per session, including restored contributions.

The contribution envelope must be plain JSON: no cycles, non-plain objects, undefined, functions or non-finite numbers. It is limited to 256 KiB serialized, 20,000 values and depth 32; renderer `state` is additionally limited to 64 KiB. Portable nodes also have the existing UI limits of depth 12 and 2,000 nodes. These stricter envelope limits do not redefine legacy `setPanel` validation.

Contributions use the existing panel lifecycle and the slot `@slot/<id>`; the placement is not the storage slot. Identity includes session, adapter and slot, and `contributionKey(adapterId, id)` encodes the adapter/ID pair without ambiguous delimiters. Legacy slots remain arbitrary, including names beginning `@slot/`: a contribution cannot overwrite an existing legacy panel at its slot. Conversely, `setPanel` at an occupied contribution slot removes that contribution first and writes the legacy panel. Deleting an untracked contribution does nothing. Restored panels count toward ownership and limits; disabling an adapter removes its contributions, including restored ones. Legacy panels retain their existing lifecycle and appear in Extensions rather than typed slots.

Portable action buttons invoke their own action ID. For contribution forms and confirms, the descriptor's `actionId` receives `{kind: "form", values}` or `{kind: "confirm", confirmed}`; cancel sends nothing. Palette Run sends `{kind: "command", source: "palette"}`; slash form submission sends `{kind: "form", values, source: "slash"}`. These go to `onAction` through the existing adapter action path, not through a Pi interaction or automatic prompt. Actions are unavailable for read-only, archived or disconnected sessions; errors are shown and a retry requires another explicit action.

Clients without slot capability receive contributions as non-interactive legacy panels in Extensions, with `mobileFallback` as text. Capable web clients render the portable node on mobile; only legacy panels and desktop `session.panel` contributions can use a custom frame. Sidebar, pills, commands and timeline cards never run frames.

### Custom message cards

`customMessageCard(message, ctx)` receives `CustomMessageInfo` (`customType`, `content`, optional `display` and `details`) for a visible Pi custom message. Return a portable node or `undefined`; adapters are tried in precedence order. The hook has the usual timeout and failure isolation. Cards use the bounded contribution JSON and UI limits above and cannot contain form or confirm nodes; explicit action buttons are supported. Hidden (`display: false`) messages do not invoke this rendering hook. `onCustomMessage` remains a separate observation hook.

A visible custom message remains a notice with readable text; a successful card is attached to that same notice, and the web offers the original text. Failure leaves the fallback intact. Older clients receive the text without card metadata. Historical imports and rewinds reconstruct text only: they do not run adapter rendering hooks or replay their side effects. Cards already stored at the coordinator remain available on normal reconnect.

### Claims and dialog responses

Pi RPC dialogs are:

| Request | Response |
|---|---|
| `{id, method: "select", title, options, timeout?}` | `{value: <one of options>}` |
| `{id, method: "confirm", title, message, timeout?}` | `{confirmed}` |
| `{id, method: "input", title, placeholder?, timeout?}` | `{value}` |
| `{id, method: "editor", title, prefill?}` | `{value}` |

Any dialog may be answered `{cancelled: true}`.

A claim is `{title, presentation: UINode, toPiResponse(resp), ownerToolCallId?}`. `toPiResponse` receives the client's `InteractionResponse` (`form`, `confirm`, `action` or `cancel`) and returns either one Pi response or `{sequence: [...]}`. Throw `InteractionResponseError` when the answer itself is invalid; the interaction stays pending and the client gets `invalid_request`.

With a sequence, the first step answers the current dialog. The rest are queued for the following dialogs of the owning tool call (`ownerToolCallId`, default the latest running tool call). A step is either a plain response (matched by shape: `{value}` fits select, input and editor; `{confirmed}` fits confirm) or `{match, response}`, where `match` is `{method?, titleIncludes?, titleStartsWith?}` or a predicate and `response` may be a function of the real request. Queued answers:

- are consumed in order, one per matching dialog;
- are re-checked against the real request (a select value must be one of its options); a mismatch drops the remaining queue with a warning and shows the dialog instead;
- expire when the owning tool call ends;
- are recorded by the host as resolved by `"host"` with the summary "Answered from your earlier form".

### Host integration

```ts
const session = registry.openSession({ sessionId, emit, initialState });
await session.onToolStart({ toolCallId, name, args });
const out = await session.onUiRequest(req);
if (out.kind === "queued") pi.respondUi(req.id, out.response);
else showInteraction(out); // out.claim, out.adapterId (null = generic)
// later, when a human answers:
const r = await session.respond(out, response);
if (r.kind === "respond") pi.respondUi(req.id, r.response);
else showInteraction(r); // adapter failed: generic claim, still waiting for a human
await session.onToolUpdate({ toolCallId, name, args, partialResult, details });
await session.onToolEnd({ toolCallId, name, args, result, isError, details });
```

`emit` receives `panel`, `attention`, `subagent`, `state`, `log` and `diagnostic` effects.

## Authoring portable presentation

Present meaningful facts, rows or tables, checklists, sections and text rather than serializing arguments or plugin state into strings. For a custom tool, `toolView.detail` can contain separately labeled input and result sections; reserve code nodes for actual code. Supply presentable `mobileFallback` text for contributions. Do not put forms in tool details.

For a pending Pi dialog, provide `Claim.presentation` and map its response with `toPiResponse`. For an adapter-owned panel or slash command, use portable form fields and `onAction` to update portable presentation; do not simulate a prompt to invoke a control. When an adapter is absent or disabled, generic tool and dialog presentation remains available. Switchyard does not rewrite arbitrary authored content or custom renderer HTML.

## Contract v2

Contract v2 adds to version 1 without changing it: the manifest's `protocolVersion` stays `1`, every v1 adapter keeps working, and a v2 adapter loads on a v1 host. The whole contract is one dependency-free type file, [`packages/adapter-sdk/src/contract.ts`](../packages/adapter-sdk/src/contract.ts): copy it next to an adapter that ships in a Pi package and use it with `import type`. The SDK checks it against its own types at compile time.

### Feature detection

`ctx.features` lists what the host supports; it is `undefined` on a host from before v2. Guard every v2 feature, because a v1 host rejects a v2 node or placement as invalid and disables the adapter for the session:

```ts
const supports = (ctx, feature) => ctx.features?.includes(feature) === true;
```

| Feature | What it allows |
|---|---|
| `tool.views.v1` | The host calls `toolView`. A v1 host never calls it, so the hook itself needs no guard. |
| `ui.nodes.v2` | `checklist`, `facts`, `rows` and `badge` nodes, `section.open` and `url` refs. |
| `adapter.trackers.v1` | The `composer.tracker` and `session.badge` placements. |
| `interaction.kinds.v1` | `Claim.kind` reaches clients. A v1 host ignores the field, so it needs no guard. |

No new capability is needed for this presentation recipe. Use the existing capability checks: older hosts do not call `toolView` without `tool.views.v1`, and adapters targeting v1 hosts must provide v1 nodes when `ui.nodes.v2` is unavailable.

The host has contract v2 whatever its coordinator runs. With a coordinator from before v2, or a client that did not announce a capability, the same data is sent in its v1 shape: a tracker as a `composer.pill` whose text is its title, count and step; a badge is left out; a checklist as a list of `[x] text` lines, facts as a two-column table, rows as a list, a badge as text, a URL as its label and address; a tool view is dropped, and the client derives the row. An adapter never has to do that itself.

### Tool views

`toolView(tool, ctx)` describes a tool call's one-line row in the transcript. It is called when the call starts (no `result`) and again when it ends. Every field is optional and overrides what the client derives from the tool's name and arguments (the name in mono and the first string argument):

```ts
interface ToolViewData {
  kind?: "read" | "edit" | "write" | "command" | "search" | "other"; // how a finished turn counts it
  verb?: string;        // finished: "Updated todo" (1 to 40 characters)
  activeVerb?: string;  // running: "Updating todo"; defaults to verb
  target?: string;      // what it acted on, in mono (at most 500 characters; "" for none)
  meta?: string[];      // up to six short facts after the target: ["2/5"]
  stat?: { added: number; removed: number };
  detail?: UINode;      // shown when the row is opened, in place of the arguments; no forms
  hide?: boolean;       // do not draw the row: a dock question or a tracker stands for the call
}
```

The host adds what Pi's result says about its built-in tools before the adapter's view is applied on top: an `edit` gets its real diff with line numbers, and a failed `bash` its exit code. `toolCard` still works and shows under the row, open; prefer `toolView` with a `detail`, which stays one line until it is opened. An unknown field or an invalid view disables the adapter like any invalid result.

### Nodes

| Node | Shape | Draws |
|---|---|---|
| `checklist` | `{t, items: [{text, state: "todo" \| "doing" \| "done" \| "skipped", note?}]}` | Steps with their state |
| `facts` | `{t, items: [{label, value, mono?}]}` | Label and value pairs (an approval's tool, command and directory) |
| `rows` | `{t, rows: [{title, status?, tone?, meta?, ref?}]}` | One line per job or subagent, with an Open link for `ref` |
| `badge` | `{t, text, tone?}` | A short word in a pill |
| `section` | `open: false` | A collapsible section that starts closed |
| `ref` | `ref: {kind: "url", url}` | An http(s) link, opened in a new tab |

### Trackers and badges

A `composer.tracker` contribution is a live summary in the row above the input: its `title`, then `tracker.count` and `tracker.step`, with a mark for `tracker.status` (`idle`, `running`, `ok`, `error`, `attention`). Opening it shows `node`, which may hold actions (with `actionId`, as for a panel). A `session.badge` contribution is a short word on the session's row in the navigator: its `node` is `text` or `badge` with at most 24 characters, and it takes no action. `composer.pill` stays valid and draws as before.

```ts
ctx.setContribution("todo", {
  placement: "composer.tracker",
  title: "Todo",
  node: { t: "checklist", items },
  mobileFallback: "2 of 5 done",
  tracker: { count: "2/5", status: "running", step: "Write the tests" },
});
```

Statuses that no adapter presented (`onStatus` returning `true`) show as one tracker named Status, from the host, in place of the Status panel.

### Dialog kinds

`Claim.kind` says what a dialog is: `"question"`, `"approval"` or `"plan"`. A question hides the row of the tool call it belongs to (the dock shows the question, and the transcript its answer) and can be answered with the number keys 1 to 9. An approval keeps its row, which is the command being approved, and is never answered by a key. Leave `kind` out when the adapter cannot tell: such a dialog gets neither. The tool call is the claim's `ownerToolCallId` when it names a running call, otherwise the running call when there is exactly one; Pi does not say which call opened a dialog, so with several in flight it stays unknown.

### A complete v2 adapter

`tasks` (`packages/adapter-examples/src/tasks/server.ts`, tested in `test/tasks.test.ts` against a v2 host and against a v1 context) is for a fictional extension with a `tasks` tool that keeps a list and an `ask_owner` tool that asks through a `select` dialog:

```ts
import type {
  AdapterContext, AdapterFeature, Claim, PiUiRequest, ServerAdapter, ToolInfo, ToolViewData, UINode,
} from "./contract.ts"; // your copy of packages/adapter-sdk/src/contract.ts

const supports = (ctx: Pick<AdapterContext, "features">, f: AdapterFeature) =>
  ctx.features?.includes(f) === true;

// A checklist where the host draws one, else a plain list.
const tasksNode = (tasks: Task[], ctx: Pick<AdapterContext, "features">): UINode =>
  supports(ctx, "ui.nodes.v2")
    ? { t: "checklist", items: tasks }
    : { t: "list", items: tasks.map((t) => ({ t: "text", text: `${MARK[t.state]} ${t.text}` })) };

function publish(tasks: Task[], ctx: AdapterContext): void {
  ctx.state.set("tasks", tasks);
  const s = summary(tasks); // { count: "1/3", step: "Write the adapter" }
  if (!supports(ctx, "adapter.trackers.v1")) {
    // Before v2: a pill with the same words.
    ctx.setContribution("tasks", {
      placement: "composer.pill", title: "Tasks", mobileFallback: fallback(tasks),
      node: { t: "text", text: `Tasks ${s.count}` },
    });
    return;
  }
  ctx.setContribution("tasks", {
    placement: "composer.tracker", title: "Tasks", mobileFallback: fallback(tasks),
    node: tasksNode(tasks, ctx),
    tracker: { count: s.count, status: "running", ...(s.step ? { step: s.step } : {}) },
  });
  ctx.setContribution("tasks-badge", {
    placement: "session.badge", title: "Tasks", mobileFallback: `Tasks ${s.count}`,
    node: { t: "badge", text: `Tasks ${s.count}` },
  });
}

const adapter: ServerAdapter = {
  onRestore(ctx) {
    const tasks = ctx.state.get<Task[]>("tasks");
    if (tasks) publish(tasks, ctx);
  },
  onToolEnd(e, ctx) {
    const tasks = e.name === "tasks" && !e.isError ? parseTasks(e.args) : null;
    if (tasks) publish(tasks, ctx);
  },
  // Only called on a host with tool.views.v1.
  toolView(tool: ToolInfo, ctx): ToolViewData | undefined {
    if (tool.name === "ask_owner") return { hide: true }; // the dock and the outcome line say it
    if (tool.name !== "tasks") return undefined;
    const tasks = parseTasks(tool.args) ?? [];
    return {
      verb: "Updated tasks", activeVerb: "Updating tasks", target: "",
      meta: tasks.length ? [summary(tasks).count] : [],
      detail: tasksNode(tasks, ctx),
    };
  },
  claimInteraction(req: PiUiRequest): Claim | undefined {
    if (req.method !== "select" || !req.title.startsWith("Owner question:")) return undefined;
    return {
      title: req.title.slice("Owner question:".length).trim(),
      kind: "question", // ignored by a v1 host
      presentation: { t: "form", formId: "ask-owner", submitLabel: "Answer", fields: [/* one select */] },
      toPiResponse: (resp) => (resp.kind === "form" ? { value: String(resp.values.answer) } : { cancelled: true }),
    };
  },
};
export default adapter;
```

## Inspection and reload

Session Details exposes adapter inspection and **Reload adapters** on capable hosts: runtime status, provenance, diagnostics, generation and any blocking reason. Reload is explicit and only succeeds for a live, writable, idle session without compaction, active tools, adapter actions, pending or unsupported dialogs, or queued answers. It prepares and restores a fresh context before swapping; it does not restart Pi. Actions carry the generation that rendered them; stale generations are rejected, and after a swap generation-less actions are rejected as well. Refresh the view and act again rather than retrying a stale action.

Terminal Pi `/reload` and pi-reload-all trigger adapter refresh once safe. Switchyard's full Pi reload requires a terminal session, no editor draft or dialogs, and a bridge capable of confirming replacement of the runtime for the same native session. An acknowledgement alone is not completion; a timeout leaves the result unknown and must not be retried blindly. If Pi reload succeeds but adapter refresh fails, the error says so. Browser refresh is not adapter reload.

The server entry module is imported by content hash, with a fresh adapter instance per session. Editing a separately imported runtime helper is not guaranteed to reload it; keep adapter entry modules self-contained. Renderer conflicts across sessions fall back to portable UI.

For a source-checkout edit loop, edit the trusted adapter's entry and manifest in its owning Pi package, make sure the session uses that package and component, then wait for idle and choose **Reload adapters** in session Details. Inspect its status, target version and provenance there and exercise the resulting UI. For an offline portable fixture instead, run the [preview recipe](development.md#adapter-development-and-cross-repository-checks); it does not reload or control the live session.

## Generic renderer

| Request | Presentation | Response |
|---|---|---|
| select | form with one single-select field | `{value}` |
| confirm | confirm node | `{confirmed}` |
| input | text field | `{value}` |
| editor | multiline text field with `prefill` | `{value}` |

Cancel maps to `{cancelled: true}` (Pi's spelling). Multi-line titles are shown in full above the field. `genericStatusPanel(statuses)` is a key/status table; tools without an adapter card use each client's built-in tool view.

## Web renderer bridge

A `webRenderer` HTML file is served to browsers in `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so it has an opaque origin and no access to cookies, storage or the API. It talks to the parent only through `postMessage`:

| Direction | Message |
|---|---|
| parent to frame | `{type: "render", node, state}`: the panel's portable node and its `state` |
| frame to parent | `{type: "action", actionId, payload}`: forwarded to the adapter's `onAction` through the adapter action API |
| frame to parent | `{type: "resize", height}`: requested height, a finite number from 0 to 4000 (`FRAME_MAX_HEIGHT`) |

The parent validates every frame message with `parseFrameMessage` (`@switchyard/protocol`, re-exported by `@switchyard/adapter-sdk`): an action needs an `actionId` of 1 to 200 characters; anything else is ignored. The web app sizes the frame to the requested height, at least 80 px and at most 4000 px. It also ignores messages from other sources. Renderers should set a restrictive Content-Security-Policy and must render a usable fallback from `node` when `state` is missing. Clients without frames (including mobile) use the portable node or `mobileFallback`. For a typed contribution, only `session.panel` can use this bridge; its optional JSON `state` is passed through to the frame. Legacy `setPanel` keeps its existing renderer behavior. See the pi-bg adapter's renderer in pi-plugins, `packages/pi-bg/src/switchyard/bg-renderer.html`.

## Adapters for the pi-plugins suite

These ship in [pi-plugins](https://github.com/justmytwospence/pi-plugins) (`packages/<pkg>/src/switchyard/`), not in Switchyard:

| Adapter | Target | Behavior |
|---|---|---|
| `ask-user-question` | `@justmytwospence/pi-ask-user-question` (tested 0.1.7) | Claims the first question dialog and shows every question in one form; answers Pi's one-dialog-at-a-time sequence from it (a claim with a `{sequence}` response, see above). |
| `tool-gate` | `@justmytwospence/pi-tool-gate` (tested 0.1.2) | Approval card: field table, note, one action per option. Follow-up message and rule-edit dialogs stay generic. |
| `plan-mode` | `@justmytwospence/pi-plan-mode` (tested 0.1.7) | Claims the "Implement this plan?" dialog and shows the plan (from `exit_plan_mode` updates) with one action per option; plan tool card and `plan` panel; `workflow-mode`, `plan`, `plan-exec` statuses to `plan-status`. |
| `subagents` | `@justmytwospence/pi-subagents` | `subagents:run` entries and `subagent` results to subagent links (view only). |
| `todo` | `@justmytwospence/pi-todo` | `todo` results (`details.tasks`) to the `todo` panel. |
| `bg` | `@justmytwospence/pi-bg` | `bg` status and widget to the `bg` panel, with a custom web renderer. |

## Worked example: hello

`@switchyard/adapter-examples` holds two documented examples: `tasks`, on contract v2 ([above](#a-complete-v2-adapter)), and `hello` (`packages/adapter-examples/src/hello/`), for a fictional extension `pi-hello` that registers a `hello` tool and reports progress with `ctx.ui.setStatus("hello", text)`. Switchyard does not load it; `exampleAdapters()` returns it for tests and experiments.

The manifest is the one at the top of this page. The server module (`server.ts`) has no runtime imports, only `import type`, so the same file would work shipped inside a Pi package:

```ts
import type { AdapterContext, ServerAdapter, ToolInfo } from "@switchyard/adapter-sdk";
import type { UINode } from "@switchyard/protocol";

const adapter: ServerAdapter = {
  // The hello tool becomes a section with a table of its arguments (plus the result text once
  // it finished). Other tools return undefined and keep the generic card.
  toolCard(tool) {
    return tool.name === "hello" ? helloCard(tool) : undefined;
  },

  // The "hello" status becomes the "hello" panel: progress when the text has a fraction ("2/5")
  // or a percentage ("40%"), plain text otherwise. An empty status clears the panel.
  onStatus(key: string, text: string | undefined, ctx: AdapterContext) {
    if (key !== "hello") return false;
    const shown = text?.trim() ? text : null;
    ctx.setPanel("hello", shown ? helloPanel(shown) : null, { title: "Hello", mobileFallback: shown });
    return true;
  },
};

export default adapter;
```

with

```ts
helloCard({ name: "hello", args: { name: "Pi", times: 2 } })
// { t: "section", title: "Hello", children: [
//     { t: "table", columns: ["Argument", "Value"], rows: [["name", "Pi"], ["times", "2"]] } ] }
helloPanel("greeting 2/4") // { t: "progress", label: "greeting 2/4", value: 0.5, status: "running" }
helloPanel("resting")      // { t: "text", text: "resting" }
```

To try it on a host, copy the emitted `packages/adapter-examples/dist/hello` directory to `~/.config/switchyard/adapters/hello` (owner tier). Its tests are in `packages/adapter-examples/test/hello.test.ts`. For interactions and dialog sequences, read the `ask-user-question` and `tool-gate` adapters in pi-plugins.
