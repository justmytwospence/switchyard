import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedAdapter,
  MANIFEST_FILE,
  parseManifest,
  type ServerAdapter,
} from "@switchyard/adapter-sdk";
import askUserQuestion from "./ask-user-question/server.js";
import askManifest from "./ask-user-question/switchyard-adapter.json" with { type: "json" };
import bg from "./bg/server.js";
import bgManifest from "./bg/switchyard-adapter.json" with { type: "json" };
import planMode from "./plan-mode/server.js";
import planManifest from "./plan-mode/switchyard-adapter.json" with { type: "json" };
import subagents from "./subagents/server.js";
import subagentsManifest from "./subagents/switchyard-adapter.json" with { type: "json" };
import todo from "./todo/server.js";
import todoManifest from "./todo/switchyard-adapter.json" with { type: "json" };
import toolGate from "./tool-gate/server.js";
import toolGateManifest from "./tool-gate/switchyard-adapter.json" with { type: "json" };

export const BUNDLED_ADAPTER_NAMES = [
  "ask-user-question",
  "tool-gate",
  "plan-mode",
  "subagents",
  "todo",
  "bg",
] as const;
export type BundledAdapterName = (typeof BUNDLED_ADAPTER_NAMES)[number];

/**
 * Absolute path of the bg adapter's custom web renderer. It lives in the source tree
 * (`src/bg/web/`) because `tsc -b` does not copy HTML; this resolves from both `src` and `dist`.
 */
export const BG_RENDERER_PATH = fileURLToPath(
  new URL("../src/bg/web/bg-renderer.html", import.meta.url),
);

const table: Record<BundledAdapterName, { manifest: unknown; server: ServerAdapter }> = {
  "ask-user-question": { manifest: askManifest, server: askUserQuestion },
  "tool-gate": { manifest: toolGateManifest, server: toolGate },
  "plan-mode": { manifest: planManifest, server: planMode },
  subagents: { manifest: subagentsManifest, server: subagents },
  todo: { manifest: todoManifest, server: todo },
  bg: { manifest: bgManifest, server: bg },
};

/** Directory holding a bundled adapter's emitted manifest and server module. */
export function bundledAdapterDir(name: BundledAdapterName): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/** The bundled adapters (tier "bundled"), in a stable order. */
export function bundledAdapters(): LoadedAdapter[] {
  return BUNDLED_ADAPTER_NAMES.map((name) => {
    const dir = bundledAdapterDir(name);
    return {
      manifest: parseManifest(table[name].manifest, `${name}/${MANIFEST_FILE}`),
      tier: "bundled",
      dir,
      manifestPath: join(dir, MANIFEST_FILE),
      webRendererPath: name === "bg" ? BG_RENDERER_PATH : null,
      server: table[name].server,
    };
  });
}

export * as askUserQuestion from "./ask-user-question/server.js";
export * as bg from "./bg/server.js";
export * as planMode from "./plan-mode/server.js";
export * as subagents from "./subagents/server.js";
export * as todo from "./todo/server.js";
export * as toolGate from "./tool-gate/server.js";
