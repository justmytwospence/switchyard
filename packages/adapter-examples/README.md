# Portable adapter examples

These examples are for adapter authors, not production integrations. `hello` targets a fictional `pi-hello` extension; its target entrypoint metadata is illustrative. Nothing loads it automatically.

From the Switchyard repository root:

```sh
pnpm build
pnpm adapter:preview -- --adapter packages/adapter-examples/src/hello --fixture packages/adapter-examples/fixtures/hello.json > /tmp/hello-preview.json
```

The CLI executes the explicitly selected **trusted** adapter in its own Node process, with ordinary Node privileges. It is not a sandbox. The runner itself constructs no Pi process, model, token or host connection; it cannot prevent trusted adapter code from doing so. Only run code you trust. The source directory uses Node's TypeScript stripping; a build emits the same entry as `dist/hello/server.js`.

The successful fixture restores a persistent panel from in-memory state, renders tool progress/cards and a portable question, submits an explicit answer, invokes a safe state-only action, and leaves an unclaimed dialog showing the generic fallback. The separate `fixtures/hello-failure.json` intentionally supplies the wrong answer shape to the adapter claim. Run it with the same command's `--fixture` flag to inspect failure isolation: the CLI emits valid JSON but exits **1**, the adapter is disabled, and the original question remains pending with the generic presentation. No answer is manufactured.

Upload the resulting JSON file in Settings → Adapters → Portable UI preview. The browser renders portable nodes only, never a custom renderer/HTML entrypoint. Desktop and phone forms, questions, actions, links and file references only append local simulated-action records with labeled fields; they never dispatch to Pi. Select read-only simulation to disable actions. Clear preview or leave the page to discard the preview and action log.

`onRestore` reads `shown`/`last` and republishes presentation; it does not replay tool hooks or produce answers. Explicit fixture actions run the real adapter's `onAction` against in-memory state. Persisted adapter state is not exported wholesale. Only published portable panels/cards/interactions and bounded diagnostics appear in the result.
