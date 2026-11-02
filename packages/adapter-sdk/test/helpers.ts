import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEffect, AdapterManifest, LoadedAdapter, ServerAdapter } from "../src/index.js";

export function manifest(id: string, extra: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id,
    version: "1.0.0",
    target: { extension: `@test/${id}`, versionRange: ">=1.0.0 <2.0.0", testedVersions: ["1.0.0"] },
    protocolVersion: 1,
    server: "server.mjs",
    webRenderer: null,
    capabilities: ["interactions"],
    ...extra,
  };
}

export function inline(
  id: string,
  server: ServerAdapter,
  tier: LoadedAdapter["tier"] = "bundled",
): LoadedAdapter {
  return {
    manifest: manifest(id),
    tier,
    dir: null,
    manifestPath: null,
    webRendererPath: null,
    server,
  };
}

export function tmp(prefix = "sy-adapter-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write an adapter dir with a manifest and an ESM server that claims selects titled `title`. */
export function writeAdapterDir(dir: string, id: string, serverSource: string, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "switchyard-adapter.json"), JSON.stringify(manifest(id, extra), null, 2));
  writeFileSync(join(dir, "server.mjs"), serverSource);
}

export function claimingServer(label: string): string {
  return `export default {
  claimInteraction(req) {
    if (req.method !== "select") return undefined;
    return {
      title: ${JSON.stringify(label)},
      presentation: { t: "text", text: ${JSON.stringify(label)} },
      toPiResponse() { return { value: req.options[0] }; },
    };
  },
};
`;
}

export function sink() {
  const effects: AdapterEffect[] = [];
  return { effects, emit: (e: AdapterEffect) => effects.push(e) };
}
