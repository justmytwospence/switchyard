---
name: switchyard-plugin-development
description: Develop new Pi plugins or change tools, commands, dialogs, structured results, entries, statuses, widgets, custom UI, or transport behavior with Switchyard compatibility.
---

# Switchyard plugin development

Before implementation, read [authoring](references/authoring.md) and [verification](references/verification.md).

For each new plugin or behavior change, assess and record the authoritative state and changed surfaces; classify each as adapter-backed, sufficiently supported by generic presentation, or explicitly documented terminal-only. Describe standalone, terminal and RPC behavior, behavior with an absent or failed adapter, and affected regression tests. Compatibility does not require identical terminal and web UI.

Keep producer, adapter, regression tests and public documentation in one logical change. Report any unverified checks and limitations; do not claim compatibility on the strength of a single kind of test.
