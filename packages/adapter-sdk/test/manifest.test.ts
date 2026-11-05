import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest, ManifestError, parseManifest } from "../src/index.js";
import { manifest, tmp } from "./helpers.js";

describe("manifest", () => {
  it("accepts a valid manifest", () => {
    const m = parseManifest(manifest("tool-gate", { webRenderer: "web/x.html" }));
    expect(m.id).toBe("tool-gate");
    expect(m.webRenderer).toBe("web/x.html");
  });

  it("accepts the retired commands capability and drops it", () => {
    const m = parseManifest(manifest("x", { capabilities: ["commands", "panels"] as never }));
    expect(m.capabilities).toEqual(["panels"]);
  });

  it.each([
    ["bad id", { id: "Tool Gate" }, "id"],
    ["protocol version", { protocolVersion: 2 }, "protocolVersion"],
    ["absolute server", { server: "/etc/server.js" }, "server"],
    [
      "bad range",
      { target: { extension: "x", versionRange: "not a range", testedVersions: [] } },
      "versionRange",
    ],
    ["unknown capability", { capabilities: ["teleport"] }, "capabilities"],
    ["extra key", { extra: true }, "extra"],
  ])("rejects %s", (_name, patch, needle) => {
    const bad = { ...manifest("x"), ...patch };
    expect(() => parseManifest(bad, "x.json")).toThrow(ManifestError);
    expect(() => parseManifest(bad, "x.json")).toThrow(new RegExp(needle));
  });

  it("rejects a missing webRenderer key (it must be explicitly null)", () => {
    const { webRenderer: _w, ...rest } = manifest("x");
    expect(() => parseManifest(rest)).toThrow(/webRenderer/);
  });

  it("loads from a directory and resolves paths", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "switchyard-adapter.json"),
      JSON.stringify(manifest("a", { webRenderer: "web/r.html" })),
    );
    const m = await loadManifest(dir);
    expect(m.manifestPath).toBe(join(dir, "switchyard-adapter.json"));
    expect(m.serverPath).toBe(join(dir, "server.mjs"));
    expect(m.webRendererPath).toBe(join(dir, "web/r.html"));
  });

  it("reports unreadable and malformed manifests", async () => {
    const dir = tmp();
    await expect(loadManifest(dir)).rejects.toThrow(/cannot read manifest/);
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "switchyard-adapter.json"), "{nope");
    await expect(loadManifest(join(dir, "b"))).rejects.toThrow(/not valid JSON/);
  });
});
