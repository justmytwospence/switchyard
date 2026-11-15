import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry, discoverPiPackages, type PiDiscoveryInventory } from "../src/index.js";
import { manifest, tmp, writeAdapterDir } from "./helpers.js";

function suite() {
  const root = realpathSync(tmp());
  const extensions: PiDiscoveryInventory["extensions"] = [];
  for (const id of ["a", "b", "legacy"]) {
    const component = join(root, "components", id);
    writeAdapterDir(
      join(component, "adapter"),
      id,
      id === "b" ? 'throw new Error("disabled adapter was imported");' : "export default {};",
      {
        target: {
          ...manifest(id).target,
          ...(id === "legacy" ? {} : { entrypoints: ["index.ts"] }),
        },
      },
    );
    writeFileSync(
      join(component, "package.json"),
      JSON.stringify({ name: `@test/${id}`, version: "3.2.1" }),
    );
    const path = join(component, "index.ts");
    writeFileSync(path, "");
    extensions.push({
      path,
      enabled: id !== "b",
      scope: "project",
      source: "..",
      packageRoot: root,
    });
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "suite-not-a-component",
      version: "99.0.0",
      switchyard: {
        adapter: ["components/a/adapter", "components/b/adapter", "components/legacy/adapter"],
      },
    }),
  );
  const inventory: PiDiscoveryInventory = { status: "available", extensions, diagnostics: [] };
  return { root, inventory };
}

async function load(
  candidates: Awaited<ReturnType<typeof discoverPiPackages>>["candidates"],
  trusted = true,
) {
  const registry = new AdapterRegistry();
  await registry.load({
    projectRoot: null,
    ownerDir: join(tmp(), "none"),
    pluginCandidates: candidates,
    projectTrusted: trusted,
  });
  return registry;
}

describe("effective Pi inventory discovery", () => {
  it("uses component versions, requires enabled AND reported entrypoints, and never imports excluded code", async () => {
    const { root, inventory } = suite();
    const discovery = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: inventory.extensions.map((e) => e.path),
    });
    expect(discovery.packages[0]).toMatchObject({
      providerRoot: root,
      source: "..",
      scope: "project",
      version: "99.0.0",
    });
    expect(
      discovery.candidates.map((c) => [c.manifest.id, c.enabled, c.provenance.targetVersion]),
    ).toEqual([
      ["a", true, "3.2.1"],
      ["b", false, "3.2.1"],
      ["legacy", true, "3.2.1"],
    ]);
    const registry = await load(discovery.candidates);
    expect(registry.adapters().map((a) => a.manifest.id)).toEqual(["a", "legacy"]);
    expect(registry.info().find((a) => a.id === "b")).toMatchObject({
      status: "disabled",
      runtimeStatus: "disabled",
      detail: "Target extension is not enabled in this session.",
      provenance: { packageDir: root, targetVersion: "3.2.1", evidence: "runtime-reported" },
    });
    expect(registry.info().find((a) => a.id === "a")?.detail).toContain("@test/a@3.2.1 is outside");
    expect(registry.info().find((a) => a.id === "legacy")?.detail).toContain(
      "Package-level discovery; adapter does not declare target entrypoints.",
    );
    expect(
      registry.diagnostics().some((d) => d.message.includes("disabled adapter was imported")),
    ).toBe(false);
    const unreported = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: [],
    });
    expect(unreported.candidates.filter((c) => c.enabled).map((c) => c.manifest.id)).toEqual([
      "legacy",
    ]);
  });

  it("uses only the resolver output, not settings merging or filter guesses", async () => {
    const { root, inventory } = suite();
    const agentDir = tmp();
    writeFileSync(join(agentDir, "settings.json"), "malformed; must not be read");
    // This models Pi's autoload:false installed-suite delta plus local '..' selection.
    const installed = suite();
    for (const ext of installed.inventory.extensions) {
      ext.enabled = false;
      ext.scope = "user";
      ext.source = "npm:suite";
    }
    inventory.extensions.push(...installed.inventory.extensions);
    const discovery = await discoverPiPackages({
      agentDir,
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: inventory.extensions.filter((e) => e.enabled).map((e) => e.path),
    });
    expect(discovery.diagnostics).toEqual([]);
    expect(
      discovery.candidates.filter((c) => c.enabled).every((c) => c.provenance.packageDir === root),
    ).toBe(true);
    expect(
      discovery.candidates
        .filter((c) => c.provenance.packageDir === installed.root)
        .every((c) => !c.enabled),
    ).toBe(true);
  });

  it("canonicalizes and deduplicates symlinked providers, paths and repeated declarations", async () => {
    const { root, inventory } = suite();
    const link = join(tmp(), "suite-link");
    symlinkSync(root, link, "dir");
    const first = inventory.extensions[0]!;
    inventory.extensions.push({
      ...first,
      packageRoot: link,
      path: first.path.replace(root, link),
      scope: "user",
    });
    const d = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: [first.path.replace(root, link)],
    });
    expect(d.packages).toHaveLength(1);
    expect(d.candidates).toHaveLength(3);
    expect(d.candidates[0]?.provenance).toMatchObject({
      scope: "project",
      packageDir: root,
      entrypoints: [first.path],
    });
    const registry = await load([...d.candidates, ...d.candidates]);
    expect(registry.info()).toHaveLength(3);
  });

  it("does not inspect project resources without trust, and skips every adapter under disabled profiles", async () => {
    const { inventory } = suite();
    const agentDir = tmp();
    for (const projectTrusted of [false, null, undefined]) {
      const d = await discoverPiPackages({ inventory, projectTrusted, agentDir });
      expect(d.candidates).toEqual([]);
      expect(d.packages).toEqual([]);
    }
    const d = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      extensionsDisabled: true,
    });
    expect(d.packages).toEqual([]);
    expect(d.candidates).toEqual([]);
    const registry = new AdapterRegistry();
    await registry.load({
      projectRoot: null,
      ownerDir: "does-not-exist",
      extensionsDisabled: true,
    });
    expect(registry.info()).toEqual([]);
  });

  it("allows explicit owner adapters, but never explicit project adapters without confirmed trust", async () => {
    const root = tmp();
    const project = join(root, "project");
    writeAdapterDir(
      join(project, ".switchyard/adapters/project"),
      "project",
      'throw new Error("untrusted project executed");',
    );
    const ownerDir = join(root, "owner");
    writeAdapterDir(join(ownerDir, "owner"), "owner", "export default {};");
    const registry = new AdapterRegistry();
    await registry.load({ projectRoot: project, ownerDir, projectTrusted: null });
    expect(registry.adapters().map((a) => a.manifest.id)).toEqual(["owner"]);
    expect(registry.diagnostics()).toEqual([]);
  });

  it("degrades unavailable/unknown-trust discovery to explicitly warned user-only legacy matching", async () => {
    const { root, inventory } = suite();
    const agentDir = tmp();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
    for (const input of [
      { inventory: { ...inventory, status: "unavailable" as const } },
      { inventory, projectTrusted: null },
    ]) {
      const d = await discoverPiPackages({ agentDir, ...input });
      expect(d.candidates.filter((c) => c.enabled).map((c) => c.manifest.id)).toEqual(["legacy"]);
      expect(d.candidates.every((c) => c.provenance.scope === "user")).toBe(true);
      expect(d.diagnostics[0]?.message).toContain("Legacy user-scope");
      const registry = await load(d.candidates);
      expect(registry.info().filter((a) => a.status === "disabled")).toHaveLength(2);
    }
  });

  it("rejects provider and target symlink escapes before import", async () => {
    const { root, inventory } = suite();
    const outside = tmp();
    writeFileSync(join(outside, "entry.ts"), "");
    symlinkSync(join(outside, "entry.ts"), join(root, "components/a/escape.ts"));
    const m = manifest("a", { target: { ...manifest("a").target, entrypoints: ["escape.ts"] } });
    writeFileSync(join(root, "components/a/adapter/switchyard-adapter.json"), JSON.stringify(m));
    writeAdapterDir(join(outside, "adapter"), "escape", 'throw new Error("escape");');
    symlinkSync(join(outside, "adapter"), join(root, "outside-adapter"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ switchyard: { adapter: ["components/a/adapter", "outside-adapter"] } }),
    );
    const d = await discoverPiPackages({ inventory, projectTrusted: true });
    expect(d.candidates).toEqual([]);
    expect(d.diagnostics.map((d) => d.message).join(" ")).toMatch(
      /escapes component root.*escapes provider root/,
    );
  });

  it("retains explicitly disabled legacy packages without importing them", async () => {
    const { root } = suite();
    const agentDir = tmp();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: root, autoload: false }] }),
    );
    const d = await discoverPiPackages({ agentDir });
    expect(d.candidates).toHaveLength(3);
    expect(d.candidates.every((c) => !c.enabled)).toBe(true);
    expect((await load(d.candidates)).adapters()).toEqual([]);
  });

  it("does not drop resolver-enabled user resources when project provenance shares a provider", async () => {
    const { root, inventory } = suite();
    inventory.extensions[0]!.scope = "user";
    inventory.extensions[0]!.source = "user-source";
    const d = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: [inventory.extensions[0]!.path],
    });
    expect(d.candidates.find((c) => c.manifest.id === "a")).toMatchObject({
      enabled: true,
      provenance: { scope: "project", source: "..", packageDir: root },
    });
  });

  it("reports stale discovery candidates as unavailable without importing changed manifests", async () => {
    const { inventory } = suite();
    const d = await discoverPiPackages({
      inventory,
      projectTrusted: true,
      reportedExtensionPaths: inventory.extensions.map((e) => e.path),
    });
    const a = d.candidates.find((c) => c.manifest.id === "a")!;
    writeFileSync(a.path, JSON.stringify({ ...a.manifest, server: "changed.mjs" }));
    writeFileSync(join(a.path, "..", "changed.mjs"), 'throw new Error("changed module executed");');
    const registry = await load(d.candidates);
    expect(registry.info().find((c) => c.id === "a")).toMatchObject({
      runtimeStatus: "unavailable",
      provenance: a.provenance,
      detail: expect.stringContaining("Manifest changed during discovery"),
    });
    unlinkSync(a.path);
    const removed = await load(d.candidates);
    expect(removed.info().find((c) => c.id === "a")).toMatchObject({
      runtimeStatus: "unavailable",
      provenance: a.provenance,
    });
  });

  it("handles missing and malformed legacy settings without imports", async () => {
    const agentDir = tmp();
    expect((await discoverPiPackages({ agentDir })).candidates).toEqual([]);
    writeFileSync(join(agentDir, "settings.json"), "{");
    expect(
      (await discoverPiPackages({ agentDir })).diagnostics.map((d) => d.message).join(" "),
    ).toContain("Cannot read Pi settings");
    mkdirSync(join(agentDir, "npm"));
  });
});
