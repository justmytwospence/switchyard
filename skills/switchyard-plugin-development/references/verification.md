# Verification

Test changed producers and consumers: successful updates, errors and cancellation, malformed or unrecognized payloads, absent and failed adapters, missing v2 features, portable fallback, restoration and cleanup, and relevant discovery and transport paths. Test standalone and terminal behavior as well as RPC. Unit tests, portable preview, real-Pi integration and terminal screen-reader proof are distinct evidence; none proves the others.

Use Node 24 or newer and build Switchyard with `pnpm build` in `$SWITCHYARD_DIR`. For a portable preview, from that checkout run:

```sh
pnpm adapter:preview -- --adapter packages/adapter-examples/src/hello --fixture packages/adapter-examples/fixtures/hello.json > /tmp/hello-preview.json
```

Upload the JSON in Settings > Adapters > Portable UI preview. The CLI executes trusted adapter code with ordinary Node privileges, not in a sandbox. Preview creates no live Pi, model or host and is not proof of live-host behavior. See [development documentation](https://github.com/justmytwospence/switchyard/blob/dev/docs/development.md) and [adapter inspection and reload](https://github.com/justmytwospence/switchyard/blob/dev/docs/adapters.md#inspection-and-reload).

## pi-plugins suite

For the pi-plugins suite, `npm run check:switchyard` invokes its compatibility wrapper. Set `SWITCHYARD_DIR` to an absolute Switchyard checkout, especially in nested worktrees. From Switchyard, after building it and installing suite dependencies, run:

```sh
SWITCHYARD_PI_PLUGINS_DIR="$PI_PLUGINS_DIR" pnpm test:plugins -- --current-suite --allow-dirty
```

Use an absolute `$PI_PLUGINS_DIR`. Missing checkout, build, dependencies or Pi are failures, not successful skips. Clean immutable CI checks the pinned pair; explicitly dirty or unpinned local checks are development evidence, not pinned CI evidence. These wrappers are suite-specific, not required installations for other plugin authors.

Report tested versions and revisions, each compatibility classification and fallback, limitations, and all unverified checks. Do not run paid evaluations, implicitly install dependencies, or change production as part of verification.
