import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedAdapter,
  MANIFEST_FILE,
  parseManifest,
  type ServerAdapter,
} from "@switchyard/adapter-sdk";
import hello from "./hello/server.js";
import helloManifest from "./hello/switchyard-adapter.json" with { type: "json" };

/**
 * Example adapters for adapter authors. Switchyard does not load them: real adapters ship with the
 * Pi packages that own them (see docs/adapters.md).
 */
export const EXAMPLE_ADAPTER_NAMES = ["hello"] as const;
export type ExampleAdapterName = (typeof EXAMPLE_ADAPTER_NAMES)[number];

const table: Record<ExampleAdapterName, { manifest: unknown; server: ServerAdapter }> = {
  hello: { manifest: helloManifest, server: hello },
};

/** Directory holding an example adapter's manifest and server module. */
export function exampleAdapterDir(name: ExampleAdapterName): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/** The example adapters, ready for `AdapterRegistry.setAdapters` (tier "bundled"). */
export function exampleAdapters(): LoadedAdapter[] {
  return EXAMPLE_ADAPTER_NAMES.map((name) => {
    const dir = exampleAdapterDir(name);
    return {
      manifest: parseManifest(table[name].manifest, `${name}/${MANIFEST_FILE}`),
      tier: "bundled",
      dir,
      manifestPath: join(dir, MANIFEST_FILE),
      webRendererPath: null,
      server: table[name].server,
    };
  });
}

export * as hello from "./hello/server.js";
