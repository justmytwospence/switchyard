# Core, module, plugin and adapter ownership

Switchyard should follow an evolving Pi setup without duplicating its workflows or promising to convert every custom terminal UI.

| Concern | Authority and placement |
|---|---|
| Hosts, sessions, workspaces, board tasks, dispatch, synchronization, review and notification delivery | Switchyard core |
| Authorization, takeover, policy and their enforcement | Switchyard core, never solely an optional plugin or module |
| Kinds of host, client, scope and trigger | A [module](modules.md) behind a core contract; core works with the module absent |
| Replaceable workflows within a Pi session | Pi and its plugins |
| Portable presentation of plugin semantics | Optional, plugin-owned adapters alongside the plugin |

## Examples

- Planning and Pi todo items belong to their plugins; a Switchyard board task is a separate core lifecycle object, not a mirror of every todo.
- Pi background subprocess jobs and subagent workflows belong to their plugins; host-service and session lifecycle remain core. Existing core agent and task orchestration primitives remain core.
- Plugin approval interfaces can present a workflow, but core authorization, takeover and policy enforcement cannot depend on their presence.
- herdr and tmux are client modules, and GitHub is a scope module. Core records what a client reports and what you bound it to, and what a scope's source syncs; it never branches on a module's kind. Without them, the web app and scopes of projects you choose still work.

Current adapters are plugin-owned. This contract does not call for migrating working policy or orchestration code. Generalize a primitive when two independent modules or plugins need it, not an entire plugin workflow.

## Feature checklist

For every meaningful plan or PR:

1. Name the authoritative state and the core, module, plugin and adapter responsibilities.
2. Describe behavior when the module, plugin or adapter is absent or fails, preserving generic evidence and safe core behavior.
3. Identify compatibility and regression tests, including relevant cross-repository checks.

Do not put plugin-ID or module-kind conditionals in coordinator or web core, workflow reducers in adapters, or fake prompts in place of plugin actions. Adapters translate; they do not become a second workflow authority.
