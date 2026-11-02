# Adapters

Pi extensions talk to their user through `ctx.ui` dialogs, status entries, widgets, custom messages and tool results. In RPC mode those arrive at the host agent as plain payloads that do not say which extension sent them. An adapter recognizes one extension's payloads and turns them into portable UI: tool cards, forms, panels, subagent links and attention items, rendered the same way on the web, phone and terminal.

Adapters run in the host agent (`@switchyard/adapter-sdk`). They are trusted, installed code and are not sandboxed. Only their optional web renderer runs in an isolated frame.

## Manifest

Every adapter is a directory with a `switchyard-adapter.json`:

```json
{
  "id": "tool-gate",
  "version": "0.1.0",
  "target": {
    "extension": "@justmytwospence/pi-tool-gate",
    "versionRange": ">=0.1.0 <0.2.0",
    "testedVersions": ["0.1.2"]
  },
  "protocolVersion": 1,
  "server": "server.js",
  "webRenderer": null,
  "capabilities": ["interactions"]
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, `.`, `_`, `-`. A higher tier with the same id replaces a lower one. |
| `version` | The adapter's own version. |
| `target.extension` | The Pi package the adapter understands. |
| `target.versionRange` | Semver range of that package. When the installed version is outside it, the adapter stays active, Settings shows a warning, and unmatched dialogs fall back to generic. |
| `target.testedVersions` | Versions verified by compatibility tests. |
| `protocolVersion` | Must be `1`. |
| `server` | ESM module, relative to the manifest, whose default export is a `ServerAdapter` or a factory `({manifest, dir}) => ServerAdapter`. |
| `webRenderer` | Relative path to an HTML file for the custom web renderer, or `null`. |
| `capabilities` | Any of `toolCards`, `interactions`, `panels`, `commands`, `progress`, `subagents`, `attention`, `state`. |

`parseManifest()` and `loadManifest()` validate it and list every problem. Unknown keys are rejected.

## Precedence and discovery

Adapters are consulted in this order:

1. **Project:** `<project root>/.switchyard/adapters/<name>/switchyard-adapter.json`.
2. **Owner:** `~/.config/switchyard/adapters/<name>/switchyard-adapter.json`.
3. **Plugin:** Pi packages that ship their own adapter. The host reads `packages` from `<PI_CODING_AGENT_DIR or ~/.pi/agent>/settings.json` and resolves each source the way Pi installs it: `npm:` sources under `<agentDir>/npm/node_modules/<name>`, git sources under `<agentDir>/git/<host>/<path>`, local paths relative to the agent dir. A package whose `package.json` has `"switchyard": {"adapter": "<dir>"}` (a path or a list of paths) contributes that adapter. Sources that cannot be resolved produce a diagnostic and are skipped. Project-scope Pi settings (`.pi/settings.json`) are not read.
4. **Bundled:** the adapters in `@switchyard/adapter-examples`.
5. **Generic renderer** for anything no adapter handles.

Within a tier, adapter directories load in name order. When two tiers provide the same `id`, only the higher one is active; Settings > Adapters lists the other as disabled ("overridden by ...").

```ts
import { AdapterRegistry, discoverPiPackages } from "@switchyard/adapter-sdk";
import { bundledAdapters } from "@switchyard/adapter-examples";

const pi = await discoverPiPackages();
const registry = new AdapterRegistry({ onDiagnostic: report });
await registry.load({
  projectRoot: "/work/repo",
  pluginPackageDirs: pi.pluginPackageDirs,
  installedPackages: pi.packages,
  bundled: bundledAdapters(),
});
```

## Hooks

```ts
interface ServerAdapter {
  toolCard?(tool, ctx): UINode | undefined;
  claimInteraction?(req: PiUiRequest, ctx): Claim | undefined;
  onToolStart?(e, ctx); onToolEnd?(e, ctx);
  onEntry?(entry, ctx); onCustomMessage?(m, ctx);
  onStatus?(key, text | undefined, ctx); onWidget?(key, lines | undefined, ctx);
  onAction?(actionId, payload, ctx);
}
```

Every hook is optional and may be async. The host calls them in precedence order:

- `toolCard` and `claimInteraction`: the first adapter that returns something wins.
- Observation hooks (`onToolStart`, `onToolEnd`, `onEntry`, `onCustomMessage`, `onStatus`, `onWidget`): every adapter is called. `onStatus` and `onWidget` may return `true` to say they presented the value; the generic status and widget panels are still kept.
- `onAction`: only the adapter named in the action.

**Failure isolation.** Each call runs inside try/catch with a 2 s timeout. A throw, a timeout, or an invalid result (a card or claim that fails `validateUINode`, a response that does not fit the dialog) disables that adapter for the rest of the session and emits an error diagnostic. The caller then falls back to generic. Nothing is ever answered automatically: a failed claim becomes the generic form, and the Pi call stays blocked until a human answers it.

### Context

Each adapter gets its own context per session:

| Member | Purpose |
|---|---|
| `sessionId`, `adapterId` | Identity. |
| `state.get/set/delete/keys` | Server-authoritative JSON state, persisted by the host and restored when the session reopens. |
| `setPanel(slot, node \| null, {title?, mobileFallback?, state?})` | Create, update or clear a panel. `state` is passed to the web renderer. |
| `attention(reason, summary)` | Raise a semantic attention item. |
| `linkSubagent({runId, label, status, sessionFile})` | Show a subagent run, linked to a read-only view of its session file. |
| `queueAnswers(matcher, responses, {toolCallId?})` | Pre-answer later dialogs of the same tool call (see below). |
| `log(level, message)` | Adapter log line. |

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
await session.onToolEnd({ toolCallId, name, args, result, isError, details });
```

`emit` receives `panel`, `attention`, `subagent`, `state`, `log` and `diagnostic` effects.

## Generic renderer

| Request | Presentation | Response |
|---|---|---|
| select | form with one single-select field | `{value}` |
| confirm | confirm node | `{confirmed}` |
| input | text field | `{value}` |
| editor | multiline text field with `prefill` | `{value}` |

Cancel maps to `{cancelled: true}`. Multi-line titles are shown in full above the field. `genericToolCard(tool)` shows the tool name, status, arguments and output; `genericStatusPanel(statuses)` is a key/status table.

## Web renderer bridge

A `webRenderer` HTML file is served to browsers in `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so it has an opaque origin and no access to cookies, storage or the API. It talks to the parent only through `postMessage`:

| Direction | Message |
|---|---|
| parent to frame | `{type: "render", node, state}`: the panel's portable node and its `state` |
| frame to parent | `{type: "action", actionId, payload}`: forwarded to the adapter's `onAction` through the adapter action API |
| frame to parent | `{type: "resize", height}`: requested frame height (at most 4000) |

The parent validates every frame message with `parseFrameMessage` and ignores messages from other sources. Renderers should set a restrictive Content-Security-Policy and must render a usable fallback from `node` when `state` is missing. Clients without frames (terminal, constrained mobile) render `node` or `mobileFallback`. See `packages/adapter-examples/src/bg/web/bg-renderer.html`.

## Bundled adapters

| Adapter | Target | Behavior |
|---|---|---|
| `ask-user-question` | `@justmytwospence/pi-ask-user-question` (tested 0.1.2) | Claims the first question dialog and shows every question in one form; answers Pi's one-dialog-at-a-time sequence from it. |
| `tool-gate` | `@justmytwospence/pi-tool-gate` (tested 0.1.2) | Approval card: field table, note, one action per option. Follow-up message and rule-edit dialogs stay generic. |
| `plan-mode` | `@justmytwospence/pi-plan-mode` | `plan-mode-plan` message to the `plan` panel; `workflow-mode`, `plan`, `plan-exec` statuses to `plan-status`. |
| `subagents` | `@justmytwospence/pi-subagents` | `subagents:run` entries and `subagent` results to subagent links (view only). |
| `todo` | `@justmytwospence/pi-todo` | `todo` results (`details.tasks`) to the `todo` panel. |
| `bg` | `@justmytwospence/pi-bg` | `bg` status and widget to the `bg` panel, with the example web renderer. |

## Worked example: ask-user-question

The plugin's tool takes `questions[1..6]`, each `{question, header, options[2..4] {label, description, preview?}, multiSelect?, showIf?: {header, answers}}`. In RPC mode it asks one dialog per question:

- single select: `select("[Fruit] Which fruit?" + preview blocks, ["1. Apple - Red", "2. Banana - Yellow", "3. Type something."])`; choosing the last opens `input("<title>\n\nType your answer:")`;
- multi select: one `input` listing the numbered options, answered `"1,3"`;
- a question whose `showIf` is unmet gets no dialog.

The adapter (`packages/adapter-examples/src/ask-user-question/server.ts`):

```ts
export default defineAdapter({
  onToolStart(e, ctx) {
    // Remember the questions of each ask_user_question call.
    if (e.name === "ask_user_question") ctx.state.set(`pending:${e.toolCallId}`, {...});
  },
  claimInteraction(req, ctx) {
    // Claim the dialog of the first question: title starts with "[<header>]" and the
    // options are numbered to match. Present one form with a field per question:
    // select (allowOther "Type something.") or multiselect, previews kept, showIf mapped
    // to Field.showIf {field: "q<n>", values}.
    return buildClaim(pending);
  },
  onToolEnd(e, ctx) {
    ctx.state.delete(`pending:${e.toolCallId}`);
  },
});
```

The form is submitted once, for example `{q1: {other: "Durian"}, q2: ["Cream", "Syrup"]}`. `toPiResponse` turns it into the plugin's sequence:

```ts
{ sequence: [
  { match: select of Fruit, response: (req) => ({ value: "3. Type something." }) },
  { match: input "Type your answer", response: { value: "Durian" } },
  { match: input of Toppings, response: { value: "1,3" } },
] }
```

The first step answers the claimed dialog; the next two answer Pi's follow-up dialogs as they arrive, so the user never types comma-separated numbers. If the plugin asks something the sequence does not expect, the queue is dropped and the remaining questions are shown individually.

Tests with recorded request payloads live in `packages/adapter-examples/test/`.
