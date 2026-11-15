import { execFile as nodeExecFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { piBin, requirePi, skipRealPi } from "@switchyard/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resourceSnapshot } from "../src/bridge/resource-snapshot.js";
import { resolveInstalledPiResources } from "../src/resources.js";

vi.mock("node:child_process", async (original) => {
  const mod = await original<typeof import("node:child_process")>();
  return { ...mod, execFile: vi.fn(mod.execFile) };
});

let root: string;
let cwd: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;
const file = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const json = (path: string, content: unknown) => file(path, JSON.stringify(content));
const pkg = (path: string, name = "fixture", entries = ["index.ts"]) => {
  json(join(path, "package.json"), { name, version: "1.0.0", pi: { extensions: entries } });
  for (const entry of entries)
    file(join(path, entry), "throw new Error('Must not load extension code');");
};
const inventory = (overrides = {}) =>
  resolveInstalledPiResources({
    piBin: piBin(),
    cwd,
    env,
    projectTrusted: true,
    extensionsDisabled: false,
    ...overrides,
  });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sy-resources-")));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("resource snapshot", () => {
  it("reports only unique file sources from tools and extension commands", () => {
    const pi = {
      getAllTools: () =>
        ["/plugins/tool.ts", "builtin:read", "/plugins/tool.ts"].map((path) => ({
          sourceInfo: { path },
        })),
      getCommands: () => [
        { source: "extension", sourceInfo: { path: "/plugins/command.ts" } },
        { source: "prompt", sourceInfo: { path: "/private/prompt.md" } },
      ],
    };
    expect(
      resourceSnapshot(
        pi,
        { cwd, isProjectTrusted: () => true, ui: { getEditorText: () => "private draft" } },
        2,
      ),
    ).toEqual({
      cwd,
      projectTrusted: true,
      reportedExtensionPaths: ["/plugins/command.ts", "/plugins/tool.ts"],
      hasEditorDraft: true,
      pendingDialogs: 2,
    });
  });
  it("uses unknown trust and a conservative missing draft guard without blocking reads", () => {
    expect(resourceSnapshot({}, { cwd })).toEqual({
      cwd,
      projectTrusted: null,
      reportedExtensionPaths: [],
      hasEditorDraft: true,
      pendingDialogs: 0,
    });
    expect(
      resourceSnapshot({}, { cwd, isProjectTrusted: () => false, ui: { getEditorText: () => "" } }),
    ).toMatchObject({
      projectTrusted: false,
      hasEditorDraft: false,
    });
  });
  it("bounds the number and length of reported paths without returning partial provenance", () => {
    expect(() =>
      resourceSnapshot(
        { getAllTools: () => [{ sourceInfo: { path: `/${"x".repeat(4096)}` } }] },
        { cwd },
      ),
    ).toThrow("4096");
    expect(() =>
      resourceSnapshot(
        {
          getAllTools: () =>
            Array.from({ length: 2049 }, (_, i) => ({ sourceInfo: { path: `/p/${i}` } })),
        },
        { cwd },
      ),
    ).toThrow("2048");
  });
});

describe.skipIf(skipRealPi)("installed Pi read-only resolution", () => {
  beforeEach(() => requirePi());
  it("uses installed npm, git and local resources with filters and provenance, without loading code or writing settings", async () => {
    const npm = join(agentDir, "npm/node_modules/fixture-npm");
    const git = join(agentDir, "git/github.com/fixture/plugin");
    const local = join(agentDir, "local");
    pkg(npm, "fixture-npm");
    pkg(git, "fixture-git");
    pkg(local, "fixture-local", ["enabled.ts", "disabled.ts"]);
    json(join(agentDir, "settings.json"), {
      packages: [
        "npm:fixture-npm@1.0.0",
        "git:github.com/fixture/plugin",
        { source: "./local", extensions: ["enabled.ts"] },
      ],
    });
    const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
    const result = await inventory();
    expect(result.status, result.diagnostics.join("\n")).toBe("available");
    expect(result.extensions).toEqual(
      expect.arrayContaining([
        {
          path: join(npm, "index.ts"),
          enabled: true,
          source: "npm:fixture-npm@1.0.0",
          scope: "user",
          packageRoot: npm,
        },
        {
          path: join(git, "index.ts"),
          enabled: true,
          source: "git:github.com/fixture/plugin",
          scope: "user",
          packageRoot: git,
        },
        {
          path: join(local, "enabled.ts"),
          enabled: true,
          source: "./local",
          scope: "user",
          packageRoot: local,
        },
        {
          path: join(local, "disabled.ts"),
          enabled: false,
          source: "./local",
          scope: "user",
          packageRoot: local,
        },
      ]),
    );
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settings);
  });
  it("resolves the local '..' suite while a project autoload=false delta disables the installed suite", async () => {
    const installed = join(agentDir, "git/github.com/fixture/suite");
    pkg(installed, "suite", ["a.ts", "b.ts"]);
    pkg(cwd, "suite", ["a.ts", "b.ts"]);
    json(join(agentDir, "settings.json"), { packages: ["git:github.com/fixture/suite"] });
    json(join(cwd, ".pi/settings.json"), {
      packages: [
        {
          source: "git:github.com/fixture/suite",
          autoload: false,
          extensions: ["!**"],
          skills: ["!**"],
          prompts: ["!**"],
          themes: ["!**"],
        },
        "..",
      ],
    });
    const result = await inventory();
    expect(result.status, result.diagnostics.join("\n")).toBe("available");
    expect(result.extensions.filter((entry) => entry.enabled).map((entry) => entry.path)).toEqual([
      join(cwd, "a.ts"),
      join(cwd, "b.ts"),
    ]);
    expect(result.extensions.filter((entry) => entry.packageRoot === installed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(installed, "a.ts"),
          enabled: false,
          scope: "project",
        }),
        expect.objectContaining({
          path: join(installed, "b.ts"),
          enabled: false,
          scope: "project",
        }),
      ]),
    );
  });
  it("lets the project npm identity override the user's installed version", async () => {
    const user = join(agentDir, "npm/node_modules/shared");
    const project = join(cwd, ".pi/npm/node_modules/shared");
    pkg(user, "shared");
    pkg(project, "shared");
    json(join(agentDir, "settings.json"), { packages: ["npm:shared@1.0.0"] });
    json(join(cwd, ".pi/settings.json"), { packages: ["npm:shared@1.0.0"] });
    const result = await inventory();
    expect(result.extensions).toEqual([
      {
        path: join(project, "index.ts"),
        enabled: true,
        source: "npm:shared@1.0.0",
        scope: "project",
        packageRoot: project,
      },
    ]);
  });
  it("does not read untrusted project settings or resolve auto-discovered project extensions", async () => {
    file(join(cwd, ".pi/settings.json"), "malformed private project settings");
    file(join(cwd, ".pi/extensions/secret.ts"), "throw new Error('Do not import')");
    file(join(agentDir, "extensions/user.ts"), "throw new Error('Do not import')");
    const result = await inventory({ projectTrusted: false });
    expect(result.status).toBe("available");
    expect(result.diagnostics).toEqual([]);
    expect(result.extensions.map((entry) => entry.scope)).toEqual(["user"]);
  });
  it.each(["{", JSON.stringify({ packages: 42 }), JSON.stringify({ extensions: [false] })])(
    "excludes malformed settings scope (%s), including auto-discovery",
    async (bad) => {
      file(join(agentDir, "settings.json"), bad);
      file(join(agentDir, "extensions/user.ts"), "");
      file(join(cwd, ".pi/extensions/project.ts"), "");
      const result = await inventory();
      expect(result.status).toBe("available");
      expect(result.diagnostics).toEqual([expect.stringContaining("user")]);
      expect(result.extensions.map((entry) => entry.scope)).toEqual(["project"]);
    },
  );
  it("excludes a malformed trusted project scope but retains user resources", async () => {
    file(join(agentDir, "extensions/user.ts"), "");
    file(join(cwd, ".pi/settings.json"), "{");
    file(join(cwd, ".pi/extensions/project.ts"), "");
    const result = await inventory();
    expect(result.status).toBe("available");
    expect(result.diagnostics).toEqual([expect.stringContaining("project")]);
    expect(result.extensions.map((entry) => entry.scope)).toEqual(["user"]);
  });
  it("never installs, updates or networks when configured npm/git packages are absent", async () => {
    const calls = join(root, "npm-calls.jsonl");
    const npm = join(root, "npm.mjs");
    file(
      npm,
      `import { appendFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
      if (args.join(' ') !== 'root -g') throw new Error('Forbidden package manager operation');
    `,
    );
    json(join(agentDir, "settings.json"), {
      npmCommand: [process.execPath, npm],
      packages: ["npm:fixture-missing@1.0.0", "git:github.com/fixture/missing"],
    });
    const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
    const result = await inventory();
    expect(result).toMatchObject({ status: "available", extensions: [] });
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([["root", "-g"]]);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settings);
    expect(existsSync(join(agentDir, "npm"))).toBe(false);
    expect(existsSync(join(agentDir, "git"))).toBe(false);
    expect(existsSync(join(agentDir, "settings.json.lock"))).toBe(false);
  });
  it("treats missing settings as empty and skips missing packages without installing", async () => {
    expect(await inventory()).toEqual({ status: "available", extensions: [], diagnostics: [] });
    json(join(agentDir, "settings.json"), {
      packages: ["./not-installed", "git:github.com/fixture/missing"],
    });
    expect((await inventory()).extensions).toEqual([]);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toContain("not-installed");
  });
});

describe("resolver failures and process contract", () => {
  function fakePi(source: string) {
    const path = join(root, "fake-pi");
    json(join(path, "package.json"), { name: "@earendil-works/pi-coding-agent", type: "module" });
    file(join(path, "dist/cli.js"), "");
    file(join(path, "dist/index.js"), source);
    return join(path, "dist/cli.js");
  }
  it("returns an empty available inventory for disabled extensions without locating Pi", async () => {
    expect(await inventory({ piBin: "/missing", extensionsDisabled: true })).toEqual({
      status: "available",
      extensions: [],
      diagnostics: [],
    });
  });
  it("fails closed for an absent package root or incompatible installed API", async () => {
    expect(await inventory({ piBin: "/missing" })).toMatchObject({
      status: "unavailable",
      extensions: [],
    });
    expect(await inventory({ piBin: fakePi("export const SettingsManager = {};") })).toMatchObject({
      status: "unavailable",
      extensions: [],
      diagnostics: [expect.stringContaining("API")],
    });
  });
  it("locates the exact Pi selected by the session cwd/env rather than the host PATH", async () => {
    const bin = fakePi("export const marker = true;");
    chmodSync(bin, 0o755);
    const hostPath = process.env.PATH;
    const result = await inventory({ piBin: "cli.js", env: { ...env, PATH: dirname(bin) } });
    expect(result).toMatchObject({
      status: "unavailable",
      diagnostics: [expect.stringContaining("API")],
    });
    const relative = await inventory({ piBin: "../fake-pi/dist/cli.js" });
    expect(relative).toEqual(result);
    expect(process.env.PATH).toBe(hostPath);
  });
  it("rejects malformed child output", async () => {
    const result = await inventory({ piBin: fakePi("process.stdout.write('not JSON');") });
    expect(result).toEqual({
      status: "unavailable",
      extensions: [],
      diagnostics: [expect.stringContaining("malformed output")],
    });
  });
  it("uses a fixed Node helper with explicit cwd/env, timeout and output cap; failures never retry", async () => {
    const exec = vi
      .mocked(nodeExecFile)
      .mockClear()
      .mockImplementationOnce(((...args: any[]) => {
        args.at(-1)(Object.assign(new Error("timed out"), { killed: true }), "", "");
      }) as typeof nodeExecFile);
    const bin = fakePi("");
    const home = process.env.HOME;
    const result = await inventory({ piBin: bin });
    expect(result).toMatchObject({
      status: "unavailable",
      extensions: [],
      diagnostics: [expect.stringContaining("timed out")],
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe(process.execPath);
    expect(exec.mock.calls[0][1]?.slice(0, 2)).toEqual(["--input-type=module", "-e"]);
    expect(exec.mock.calls[0][2]).toMatchObject({
      cwd,
      env,
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    expect(process.env.HOME).toBe(home);
  });
});
