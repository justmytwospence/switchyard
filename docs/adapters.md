# Adapters

Pi extensions talk to their user through `ctx.ui` dialogs, status entries, widgets, custom messages and tool results. In RPC mode those arrive at the host agent as plain payloads that do not say which extension sent them. An adapter recognizes one extension's payloads and turns them into portable UI: tool cards, forms, panels, subagent links and attention items, rendered the same way on the web, phone and terminal.

Adapters run in the host agent (`@switchyard/adapter-sdk`). They are trusted, installed code and are not sandboxed. Only their optional web renderer runs in an isolated frame.

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
| `target.testedVersions` | Versions verified by compatibility tests. |
| `protocolVersion` | Must be `1`. |
| `server` | ESM module, relative to the manifest, whose default export is a `ServerAdapter` or a factory `({manifest, dir}) => ServerAdapter`. A `.ts` file works too: Node (24 or later) strips its types on import, so it may use only erasable syntax (see [Shipping an adapter with your Pi package](#shipping-an-adapter-with-your-pi-package)). |
| `webRenderer` | Relative path to an HTML file for the custom web renderer, or `null`. |
| `capabilities` | Any of `toolCards`, `interactions`, `panels`, `commands`, `progress`, `subagents`, `attention`, `state`. |

`parseManifest()` and `loadManifest()` validate it and list every problem. Unknown keys are rejected.

## Precedence and discovery

Adapters are consulted in this order:

1. **Project:** `<project root>/.switchyard/adapters/<name>/switchyard-adapter.json`.
2. **Owner:** `~/.config/switchyard/adapters/<name>/switchyard-adapter.json`.
3. **Plugin:** Pi packages that ship their own adapter. The host reads `packages` from `<PI_CODING_AGENT_DIR or ~/.pi/agent>/settings.json` and resolves each source the way Pi installs it: `npm:` sources under `<agentDir>/npm/node_modules/<name>`, git sources under `<agentDir>/git/<host>/<path>`, local paths relative to the agent dir. A package whose `package.json` has `"switchyard": {"adapter": "<dir>"}` (a path or a list of paths) contributes that adapter. Sources that cannot be resolved produce a diagnostic and are skipped. Project-scope Pi settings (`.pi/settings.json`) are not read.
4. **Bundled:** adapters the embedding code passes in (`AdapterCatalog`'s `bundled` option). The host agent bundles none: adapters ship with the Pi packages that own them.
5. **Generic renderer** for anything no adapter handles.

Within a tier, adapter directories load in name order. When two tiers provide the same `id`, only the higher one is active; Settings > Adapters lists the other as disabled ("overridden by ...").

```ts
import { AdapterRegistry, discoverPiPackages } from "@switchyard/adapter-sdk";

const pi = await discoverPiPackages();
const registry = new AdapterRegistry({ onDiagnostic: report });
await registry.load({
  projectRoot: "/work/repo",
  pluginPackageDirs: pi.pluginPackageDirs,
  installedPackages: pi.packages,
});
```

## Shipping an adapter with your Pi package

The usual home for an adapter is the Pi package whose extension it understands, so the two change and version together. Put the adapter directory (manifest plus server module) anywhere in the package and list it in the package's `package.json`:

```json
{
  "name": "pi-hello",
  "pi": { "extensions": ["./src/index.ts"] },
  "switchyard": { "adapter": "./src/switchyard" }
}
```

`switchyard.adapter` is a path or a list of paths, relative to the package root, so a suite of several extensions can declare one adapter per package from its root `package.json`. When the owner installs the package with Pi (`pi install npm:...`, `git:...` or a local path), every host that reads that agent dir's `settings.json` loads the adapter in the plugin tier. Nothing is installed into Switchyard.

The server module may be TypeScript (`"server": "adapter.ts"`), loaded with Node's built-in type stripping:

- **Erasable syntax only:** type annotations, interfaces, type aliases, `as` and `satisfies`, and `import type`. No `enum`, `namespace`, parameter properties or other syntax that needs code generation.
- **No runtime imports.** The `@switchyard/*` packages are not published, and Pi packages should not depend on Switchyard. Declare the few types the adapter needs (`UINode`, `Claim`, `AdapterContext`, ...) locally, copied structurally from `@switchyard/protocol` and `@switchyard/adapter-sdk`, and build nodes and claims as plain objects.
- **Not inside `node_modules`.** Node refuses to strip types there. Git and local installs live outside it (`<agentDir>/git/<host>/<path>`); an npm install of a package with a `.ts` adapter fails to load, and the host reports the load error as a diagnostic in Settings > Adapters. Ship compiled `.js` if the package is installed from npm.

The real-world example is [pi-plugins](https://github.com/justmytwospence/pi-plugins): each package keeps its adapter in `packages/<pkg>/src/switchyard/{adapter.ts, switchyard-adapter.json}` with a test beside the package's other tests, and the root `package.json` lists all of them in `switchyard.adapter`. Switchyard's compatibility tests (`packages/host-agent/test/compat/`) load that suite through the plugin tier against real Pi (see [compatibility.md](compatibility.md#plugin-compatibility)).

## Hooks

```ts
interface ServerAdapter {
  toolCard?(tool, ctx): UINode | undefined;
  claimInteraction?(req: PiUiRequest, ctx): Claim | undefined;
  onToolStart?(e, ctx); onToolUpdate?(e, ctx); onToolEnd?(e, ctx);
  onEntry?(entry, ctx); onCustomMessage?(m, ctx);
  onStatus?(key, text | undefined, ctx); onWidget?(key, lines | undefined, ctx);
  onAction?(actionId, payload, ctx);
}
```

Every hook is optional and may be async. The host calls them in precedence order:

- `toolCard` and `claimInteraction`: the first adapter that returns something wins.
- Observation hooks (`onToolStart`, `onToolUpdate`, `onToolEnd`, `onEntry`, `onCustomMessage`, `onStatus`, `onWidget`): every adapter is called. `onToolUpdate` gets each `tool_execution_update` with the partial result and its `details`. `onStatus` and `onWidget` may return `true` to say they presented the value: the host then leaves that status key out of the generic Status panel, or removes the generic `widget:<key>` panel. Return nothing (or `false`) to keep the generic presentation; if the adapter is later disabled, the key's next update shows in the generic panel again.
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
await session.onToolUpdate({ toolCallId, name, args, partialResult, details });
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

Cancel maps to `{cancelled: true}` (Pi's spelling). Multi-line titles are shown in full above the field. `genericStatusPanel(statuses)` is a key/status table; tools without an adapter card use each client's built-in tool view.

## Web renderer bridge

A `webRenderer` HTML file is served to browsers in `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so it has an opaque origin and no access to cookies, storage or the API. It talks to the parent only through `postMessage`:

| Direction | Message |
|---|---|
| parent to frame | `{type: "render", node, state}`: the panel's portable node and its `state` |
| frame to parent | `{type: "action", actionId, payload}`: forwarded to the adapter's `onAction` through the adapter action API |
| frame to parent | `{type: "resize", height}`: requested height, a finite number from 0 to 4000 (`FRAME_MAX_HEIGHT`) |

The parent validates every frame message with `parseFrameMessage` (`@switchyard/protocol`, re-exported by `@switchyard/adapter-sdk`): an action needs an `actionId` of 1 to 200 characters; anything else is ignored. The web app sizes the frame to the requested height, at least 80 px and at most 4000 px. It also ignores messages from other sources. Renderers should set a restrictive Content-Security-Policy and must render a usable fallback from `node` when `state` is missing. Clients without frames (terminal, constrained mobile) render `node` or `mobileFallback`. See the pi-bg adapter's renderer in pi-plugins, `packages/pi-bg/src/switchyard/bg-renderer.html`.

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

`@switchyard/adapter-examples` holds one documented example, `hello` (`packages/adapter-examples/src/hello/`), for a fictional extension `pi-hello` that registers a `hello` tool and reports progress with `ctx.ui.setStatus("hello", text)`. Switchyard does not load it; `exampleAdapters()` returns it for tests and experiments.

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
