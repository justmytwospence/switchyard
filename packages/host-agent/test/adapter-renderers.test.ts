import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedAdapter } from "@switchyard/adapter-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterCatalog } from "../src/adapters.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-renderer-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const manifest = (id: string) => ({
  id,
  version: "1.0.0",
  protocolVersion: 1 as const,
  target: { extension: "fixture", versionRange: "*", testedVersions: [] },
  server: "server.mjs",
  webRenderer: "renderer.html",
  capabilities: ["panels" as const],
});
const session = (sessionId: string, cwd: string) => ({
  sessionId,
  cwd,
  resources: { status: "available" as const, extensions: [], diagnostics: [] },
  reportedExtensionPaths: [],
  projectTrusted: true,
  extensionsDisabled: false,
});
const projectAdapter = (root: string, id: string, html: string) => {
  const dir = join(root, ".switchyard", "adapters", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "switchyard-adapter.json"), JSON.stringify(manifest(id)));
  writeFileSync(join(dir, "server.mjs"), "export default {};\n");
  writeFileSync(join(dir, "renderer.html"), html);
  return dir;
};

describe("published adapter renderer catalog", () => {
  it("publishes bounded HTML, detects content-only changes and replaces workspace snapshots", async () => {
    const root = temp();
    const adapterDir = projectAdapter(root, "frame", "first");
    const catalog = new AdapterCatalog({ ownerDir: temp(), env: { PI_CODING_AGENT_DIR: temp() } });
    await catalog.init();
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({ frame: "first" });
    writeFileSync(join(adapterDir, "renderer.html"), "second");
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({ frame: "second" });
    rmSync(adapterDir, { recursive: true });
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({});
  });

  it("keys renderer snapshots by session, stages ambiguity, and removes it on release", async () => {
    const root = temp();
    const dir = projectAdapter(root, "frame", "first");
    const catalog = new AdapterCatalog({ ownerDir: temp(), env: { PI_CODING_AGENT_DIR: temp() } });
    await catalog.init();
    await catalog.forSession(session("one", root));
    writeFileSync(join(dir, "renderer.html"), "second");
    const candidate = await catalog.prepareSession(session("two", root));
    expect(catalog.renderers()).toEqual({ frame: "first" });
    expect(catalog.sessionInfo("two")).toEqual([]);
    expect(catalog.sessionDiagnostics("one")).toEqual([]);
    candidate.commit();
    expect(catalog.renderers()).toEqual({});
    for (const id of ["one", "two"]) {
      expect(catalog.sessionInfo(id)[0].webRenderer).toBe(false);
      expect(catalog.sessionDiagnostics(id)).toEqual([
        expect.objectContaining({
          sessionId: id,
          adapterId: "frame",
          message: expect.stringContaining("Ambiguous"),
        }),
      ]);
    }
    await catalog.forSession(session("unrelated", temp()));
    expect(catalog.sessionDiagnostics("unrelated")).toEqual([]);
    catalog.releaseSession("two");
    expect(catalog.renderers()).toEqual({ frame: "first" });
    expect(catalog.sessionDiagnostics("one")).toEqual([]);
    expect(catalog.sessionInfo("two")).toEqual([]);
    catalog.releaseSession("one");
    expect(catalog.renderers()).toEqual({});
    expect(catalog.info()).toEqual([]);
  });

  it("does not pin startup owner renderer bytes across a committed refresh", async () => {
    const root = temp();
    const dir = projectAdapter(root, "owner", "first");
    const catalog = new AdapterCatalog({ ownerDir: dir, env: { PI_CODING_AGENT_DIR: temp() } });
    await catalog.init();
    expect(catalog.renderers()).toEqual({ owner: "first" });
    writeFileSync(join(dir, "renderer.html"), "updated");
    await catalog.forSession(session("owner-refresh", temp()));
    expect(catalog.renderers()).toEqual({ owner: "updated" });
  });

  it("fails portable when UTF-8 decoding expands an otherwise bounded renderer", async () => {
    const root = temp();
    const dir = projectAdapter(root, "invalid", "first");
    writeFileSync(join(dir, "renderer.html"), Buffer.alloc(256 * 1024, 0xff));
    const catalog = new AdapterCatalog({ ownerDir: temp(), env: { PI_CODING_AGENT_DIR: temp() } });
    await catalog.forSession(session("invalid", root));
    expect(catalog.renderers()).toEqual({});
    expect(catalog.sessionDiagnostics("invalid")).toEqual([
      expect.objectContaining({
        sessionId: "invalid",
        message: expect.stringContaining("decoded HTML exceeds 256 KiB"),
      }),
    ]);
  });

  it("caps the combined map in stable adapter-ID order", async () => {
    const root = temp();
    const file = join(root, "renderer.html");
    writeFileSync(file, "x".repeat(256 * 1024));
    const bundled: LoadedAdapter[] = Array.from({ length: 33 }, (_, index) => ({
      manifest: manifest(`frame-${String(index).padStart(2, "0")}`),
      tier: "bundled" as const,
      dir: root,
      manifestPath: null,
      webRendererPath: file,
      server: {},
    }));
    const diagnostics: string[] = [];
    const catalog = new AdapterCatalog({
      ownerDir: temp(),
      env: { PI_CODING_AGENT_DIR: temp() },
      bundled,
      onDiagnostic: (d) => diagnostics.push(d.message),
    });
    await catalog.init();
    expect(Object.keys(catalog.renderers())).toHaveLength(32);
    expect(catalog.renderers()).toHaveProperty("frame-31");
    expect(catalog.renderers()).not.toHaveProperty("frame-32");
    expect(catalog.info().find((a) => a.id === "frame-32")?.webRenderer).toBe(false);
    expect(diagnostics.some((d) => d.includes("8 MiB"))).toBe(true);
  });

  it("omits unreadable and oversized assets, and project disagreements fail closed", async () => {
    const root = temp();
    const owner = temp();
    const file = join(owner, "renderer.html");
    writeFileSync(file, "base");
    const bundled: LoadedAdapter = {
      manifest: manifest("frame"),
      tier: "bundled",
      dir: owner,
      manifestPath: null,
      webRendererPath: file,
      server: {},
    };
    const diagnostics: string[] = [];
    const catalog = new AdapterCatalog({
      ownerDir: temp(),
      env: { PI_CODING_AGENT_DIR: temp() },
      bundled: [bundled],
      onDiagnostic: (d) => diagnostics.push(d.message),
    });
    await catalog.init();
    expect(catalog.renderers()).toEqual({ frame: "base" });
    await catalog.forSession(session("base", temp()));
    const project = projectAdapter(root, "frame", "different");
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({});
    expect(
      catalog
        .info()
        .filter((a) => a.id === "frame")
        .every((a) => !a.webRenderer),
    ).toBe(true);
    expect(diagnostics.some((d) => d.includes("Ambiguous"))).toBe(true);
    writeFileSync(join(project, "renderer.html"), "base");
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({ frame: "base" });
    writeFileSync(join(project, "renderer.html"), "x".repeat(256 * 1024 + 1));
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({});
    expect(diagnostics.some((d) => d.includes("256 KiB"))).toBe(true);
    rmSync(join(project, "renderer.html"));
    await catalog.forSession(session("project", root));
    expect(catalog.renderers()).toEqual({});
    expect(diagnostics.some((d) => d.includes("does not exist"))).toBe(true);
  });
});
