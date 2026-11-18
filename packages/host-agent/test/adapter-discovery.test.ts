// @module-tag slow
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDiagnostic, LoadedAdapter } from "@switchyard/adapter-sdk";
import { SessionAdapterInfo as SessionAdapterInfoSchema } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterCatalog, type SessionAdapterInput } from "../src/adapters.js";

const dirs: string[] = [];
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-catalog-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const manifest = (id: string, bound = false) => ({
  id,
  version: "1.0.0",
  protocolVersion: 1 as const,
  target: {
    extension: "fixture-component",
    versionRange: "^2.0.0",
    testedVersions: ["2.0.0"],
    ...(bound ? { entrypoints: ["index.ts"] } : {}),
  },
  server: "server.mjs",
  webRenderer: "renderer.html",
  capabilities: ["panels" as const],
});
function adapter(dir: string, id: string, bound = false): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "switchyard-adapter.json"), JSON.stringify(manifest(id, bound)));
  const marker = join(dir, "imported");
  writeFileSync(
    join(dir, "server.mjs"),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'loaded');
export default () => ({});\n`,
  );
  writeFileSync(join(dir, "renderer.html"), id);
  return marker;
}
function packageFixture(scope: "user" | "project" = "project", bound = true) {
  const root = temp();
  const component = join(root, "components", "fixture");
  const dir = join(component, "adapter");
  const marker = adapter(dir, "plugin", bound);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-provider",
      version: "99.0.0",
      switchyard: { adapter: "components/fixture/adapter" },
    }),
  );
  writeFileSync(
    join(component, "package.json"),
    JSON.stringify({ name: "fixture-component", version: "2.1.0" }),
  );
  const entry = join(component, "index.ts");
  writeFileSync(entry, "// no extension execution\n");
  return {
    root,
    dir,
    marker,
    entry,
    resource: { path: entry, enabled: true, source: root, scope, packageRoot: root },
  };
}
function input(sessionId: string, cwd = temp()): SessionAdapterInput {
  return {
    sessionId,
    cwd,
    resources: { status: "available", extensions: [], diagnostics: [] },
    reportedExtensionPaths: [],
    projectTrusted: true,
    extensionsDisabled: false,
  };
}
function catalog(diagnostics: AdapterDiagnostic[] = []) {
  const agentDir = temp();
  const ownerDir = temp();
  return {
    agentDir,
    ownerDir,
    catalog: new AdapterCatalog({
      ownerDir,
      env: { PI_CODING_AGENT_DIR: agentDir },
      onDiagnostic: (d) => diagnostics.push(d),
    }),
  };
}

describe("session adapter catalog", () => {
  it("initializes only explicit owner adapters, and the legacy cwd wrapper cannot infer trust", async () => {
    const { agentDir, ownerDir, catalog: c } = catalog();
    const plugin = packageFixture("user", false);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [plugin.root] }));
    const ownerMarker = adapter(join(ownerDir, "owner"), "owner");
    const request = input("untrusted");
    const projectMarker = adapter(
      join(request.cwd, ".switchyard", "adapters", "project"),
      "project",
    );
    await c.init();
    expect(existsSync(ownerMarker)).toBe(true);
    expect(existsSync(plugin.marker)).toBe(false);
    expect(existsSync(projectMarker)).toBe(false);
    expect(c.info().map((a) => a.id)).toEqual(["owner"]);
    await c.forWorkspace(request.cwd);
    expect(existsSync(plugin.marker)).toBe(false);
    expect(existsSync(projectMarker)).toBe(false);
    expect(c.info().map((a) => a.id)).toEqual(["owner"]);
  });

  it("requires configured and runtime-reported entrypoints and keeps session statuses isolated", async () => {
    const { catalog: c } = catalog();
    const plugin = packageFixture();
    const enabled = input("enabled");
    enabled.resources.extensions = [plugin.resource];
    enabled.reportedExtensionPaths = [plugin.entry];
    const disabled = {
      ...enabled,
      sessionId: "filtered",
      resources: {
        ...enabled.resources,
        extensions: [{ ...plugin.resource, enabled: false }],
      },
    };
    await c.forSession(disabled);
    expect(existsSync(plugin.marker)).toBe(false);
    expect(c.sessionInfo("filtered")[0]).toMatchObject({
      id: "plugin",
      status: "disabled",
      runtimeStatus: "disabled",
      runtimeDetail: "Target extension is not enabled in this session.",
    });
    await c.forSession(enabled);
    expect(existsSync(plugin.marker)).toBe(true);
    expect(c.sessionInfo("enabled")[0]).toMatchObject({
      status: "active",
      runtimeStatus: "active",
      provenance: {
        scope: "project",
        packageDir: plugin.root,
        targetVersion: "2.1.0",
        entrypoints: [plugin.entry],
        evidence: "runtime-reported",
      },
    });
    expect(c.sessionInfo("filtered")[0].runtimeStatus).toBe("disabled");
    expect(c.sessionDiagnostics("enabled").some((d) => d.message.includes("outside"))).toBe(false);
    await c.forSession({ ...enabled, sessionId: "not-reported", reportedExtensionPaths: [] });
    expect(c.sessionInfo("not-reported")[0].runtimeStatus).toBe("disabled");
    expect(c.sessionInfo("missing")).toEqual([]);
  });

  it("never imports project code without confirmed trust and available resources", async () => {
    for (const trust of [false, null, true]) {
      const { catalog: c } = catalog();
      const plugin = packageFixture();
      const request = input(`trust-${trust}`);
      const marker = adapter(join(request.cwd, ".switchyard", "adapters", "project"), "project");
      request.projectTrusted = trust;
      request.resources = {
        status: trust === true ? "unavailable" : "available",
        extensions: [plugin.resource],
        diagnostics: [],
      };
      request.reportedExtensionPaths = [plugin.entry];
      await c.forSession(request);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(plugin.marker)).toBe(false);
      expect(c.sessionInfo(request.sessionId)).toEqual([]);
    }
  });

  it("Vanilla/no-extensions sessions do not inherit any adapter or renderer from another session", async () => {
    const { ownerDir, catalog: c } = catalog();
    adapter(join(ownerDir, "owner"), "owner");
    const normal = input("normal");
    await c.forSession(normal);
    await c.forSession({ ...normal, sessionId: "vanilla", extensionsDisabled: true });
    expect(c.sessionInfo("normal").map((a) => a.id)).toEqual(["owner"]);
    expect(c.sessionInfo("vanilla")).toEqual([]);
    expect(c.sessionDiagnostics("vanilla")).toEqual([]);
    c.releaseSession("normal");
    expect(c.renderers()).toEqual({});
    expect(c.info()).toEqual([]);
  });

  it("uses user-only legacy fallback with an explicit warning, and never guesses bound entrypoints", async () => {
    const { agentDir, catalog: c } = catalog();
    const coarse = packageFixture("user", false);
    const bound = packageFixture("user");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [coarse.root, bound.root] }),
    );
    const request = input("old-bridge");
    request.projectTrusted = null;
    request.resources = { status: "unavailable", extensions: [], diagnostics: ["unsupported"] };
    await c.forSession(request);
    expect(existsSync(coarse.marker)).toBe(true);
    expect(existsSync(bound.marker)).toBe(false);
    expect(c.sessionInfo(request.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeStatus: "active",
          provenance: expect.objectContaining({ scope: "user", evidence: "package-level" }),
        }),
        expect.objectContaining({
          runtimeStatus: "disabled",
          provenance: expect.objectContaining({ evidence: "runtime-reported" }),
        }),
      ]),
    );
    expect(
      c.sessionDiagnostics(request.sessionId).some((d) => d.message.includes("Legacy user-scope")),
    ).toBe(true);
  });

  it("publishes only committed candidates, replaces removed records, and discards candidates on release", async () => {
    const reported: AdapterDiagnostic[] = [];
    const { catalog: c } = catalog(reported);
    const request = input("staged");
    const dir = join(request.cwd, ".switchyard", "adapters", "project");
    adapter(dir, "project");
    await c.forSession(request);
    expect(c.renderers()).toEqual({ project: "project" });
    writeFileSync(join(dir, "renderer.html"), "edited");
    const candidate = await c.prepareSession({
      ...request,
      resources: { ...request.resources, diagnostics: ["candidate only"] },
    });
    expect(candidate.registry.info()[0].status).toBe("active");
    expect(c.renderers()).toEqual({ project: "project" });
    expect(c.sessionDiagnostics(request.sessionId)).toEqual([]);
    expect(reported).toEqual([]);
    candidate.dispose();
    expect(() => candidate.commit()).toThrow("disposed");
    expect(c.renderers()).toEqual({ project: "project" });
    const replacement = await c.prepareSession(request);
    replacement.commit();
    replacement.commit();
    replacement.dispose();
    expect(c.renderers()).toEqual({ project: "edited" });
    rmSync(dir, { recursive: true });
    const removed = await c.prepareSession(request);
    expect(c.sessionInfo(request.sessionId)).toHaveLength(1);
    removed.commit();
    expect(c.sessionInfo(request.sessionId)).toEqual([]);
    expect(c.info()).toEqual([]);
    expect(c.renderers()).toEqual({});
    const pending = c.prepareSession(request);
    c.releaseSession(request.sessionId);
    const retired = await pending;
    expect(() => retired.commit()).toThrow("disposed");
    retired.dispose();
    expect(c.sessionDiagnostics(request.sessionId)).toEqual([]);
  });

  it("sanitizes and bounds inspection copies without truncating active registries", async () => {
    const root = temp();
    const bundled: LoadedAdapter[] = Array.from({ length: 257 }, (_, i) => ({
      manifest: manifest(`adapter-${i}`),
      tier: "bundled",
      dir: root,
      manifestPath: null,
      webRendererPath: null,
      server: {},
      provenance: {
        scope: "explicit",
        source: `\u001b[31m${"s".repeat(5000)}`,
        packageDir: root,
        manifestPath: null,
        targetVersion: null,
        entrypoints: Array.from({ length: 129 }, () => "p".repeat(5000)),
        evidence: "explicit",
      },
    }));
    const c = new AdapterCatalog({
      bundled,
      ownerDir: temp(),
      env: { PI_CODING_AGENT_DIR: temp() },
    });
    const request = input("bounded");
    request.resources.diagnostics = Array.from(
      { length: 150 },
      () => `\u001b[31mnotice\n${"x".repeat(5000)}`,
    );
    const registry = await c.forSession(request);
    expect(registry.adapters()).toHaveLength(257);
    const info = c.sessionInfo("bounded");
    expect(info).toHaveLength(256);
    expect(SessionAdapterInfoSchema.safeParse(info[0]).success).toBe(true);
    expect(info[0].provenance.source).toHaveLength(4096);
    expect(info[0].provenance.entrypoints).toHaveLength(128);
    info[0].provenance.entrypoints.length = 0;
    expect(c.sessionInfo("bounded")[0].provenance.entrypoints).toHaveLength(128);
    const diagnostics = c.sessionDiagnostics("bounded");
    expect(diagnostics).toHaveLength(100);
    expect(
      diagnostics.every(
        (d) => d.sessionId === "bounded" && d.message.length <= 4000 && !/\p{Cc}/u.test(d.message),
      ),
    ).toBe(true);
    expect(diagnostics.at(-1)?.message).toContain("truncated");
    expect(c.sessionDiagnostics("other")).toEqual([]);
  });
});
