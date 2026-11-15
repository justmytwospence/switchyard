#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

// This CLI IS the isolated authoring process. Adapter code is explicitly trusted and
// has ordinary Node privileges; process separation is not a security sandbox.
const stdout = process.stdout.write.bind(process.stdout);
// Keep adapter console/raw stdout chatter out of the machine-readable result.
process.stdout.write = process.stderr.write.bind(process.stderr);

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !["--adapter", "--fixture"].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      flags.has(flag)
    ) {
      throw new Error(
        "Usage: pnpm adapter:preview -- --adapter <trusted directory> --fixture <file>",
      );
    }
    flags.set(flag, value);
  }
  if (!flags.has("--adapter") || !flags.has("--fixture"))
    throw new Error("Both --adapter and --fixture are required");
  const { ADAPTER_PREVIEW_MAX_BYTES, parseAdapterPreviewFixtureJson } = await import(
    "../packages/protocol/dist/index.js"
  );
  const { runAdapterPreview } = await import("../packages/adapter-sdk/dist/index.js");
  const path = resolve(flags.get("--fixture"));
  if ((await stat(path)).size > ADAPTER_PREVIEW_MAX_BYTES)
    throw new Error("Fixture exceeds 1 MiB input limit");
  const fixture = parseAdapterPreviewFixtureJson(await readFile(path, "utf8"));
  process.stderr.write(
    "Executing the explicitly selected trusted adapter with Node privileges (not a sandbox). No live Pi/model/host is constructed by the preview runner.\n",
  );
  const preview = await runAdapterPreview({ adapter: resolve(flags.get("--adapter")), fixture });
  for (const diagnostic of preview.diagnostics)
    process.stderr.write(`${diagnostic.level}: ${diagnostic.message}\n`);
  // Compact output stays within the same byte limit as the validated payload.
  await new Promise((resolve, reject) =>
    stdout(`${JSON.stringify(preview)}\n`, (error) => (error ? reject(error) : resolve())),
  );
  return preview.steps.some((step) => !step.ok) ? 1 : 0;
}

let exitCode;
try {
  exitCode = await main();
} catch (error) {
  process.stderr.write(
    `Adapter preview failed: ${error instanceof Error ? error.message : String(error)}\nBuild first with pnpm build if dist modules are missing.\n`,
  );
  exitCode = 1;
}
// An adapter's stray timer must not keep a fixture process alive.
process.exit(exitCode);
