import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalExtensionPath, terminalSupport } from "@switchyard/pi-runtime";
import type {
  AdapterInfo,
  HostCommand,
  HostEvent,
  Interaction,
  Panel,
  Profile,
  SessionAdaptersResult,
  TranscriptItem,
} from "@switchyard/protocol";
import { ADAPTER_CONTRACT_FEATURE } from "@switchyard/protocol";
import {
  type MockModelServer,
  type MockScript,
  makePiEnv,
  type PiEnv,
  piBin,
  realPiSkipReason,
  requirePi,
  startMockModel,
} from "@switchyard/test-fixtures";
// The compatibility tests drive the real host agent (supervisor, adapter catalog, interactions)
// through the same fake coordinator the other host-agent tests use.
import { expect } from "vitest";
import { type HostAgentHandle, runHostAgent, silentLogger } from "../../src/index.js";
import { FakeCoordinator, mockProfile, startCommand, tempDir, waitFor } from "../helpers.js";

export { waitFor };

/** Suite checkout. Required checks fail rather than skip when it is unavailable. */
export const PLUGINS_DIR = process.env.SWITCHYARD_PI_PLUGINS_DIR ?? "";

export type PluginName =
  | "pi-ask-user-question"
  | "pi-tool-gate"
  | "pi-plan-mode"
  | "pi-todo"
  | "pi-bg"
  | "pi-subagents";

export const pluginDir = (name: PluginName) => join(PLUGINS_DIR, "packages", name);

/** A plugin's extension entry, relative to the pi-plugins root (pi-todo keeps it at the top). */
export const pluginExtension = (name: PluginName) =>
  name === "pi-todo" ? `packages/${name}/index.ts` : `packages/${name}/src/index.ts`;

/**
 * The `settings.json` `packages` entry that loads `plugins` from the pi-plugins checkout, the way
 * an installed suite is found in production: Pi loads only these extensions (no skills, prompts
 * or themes), and the host's plugin tier reads the adapters from the root `switchyard.adapter`.
 */
export function pluginPackages(plugins: PluginName[], suiteDir = PLUGINS_DIR) {
  return [
    {
      source: suiteDir,
      extensions: plugins.map(pluginExtension),
      skills: [],
      prompts: [],
      themes: [],
    },
  ];
}

/** Why the compat tests skip, or null when they must run. */
export function compatSkipReason(): string | null {
  const required = process.env.SWITCHYARD_REQUIRE_PI_PLUGINS === "1";
  const reason =
    realPiSkipReason() ??
    (!PLUGINS_DIR
      ? "SWITCHYARD_PI_PLUGINS_DIR is not set"
      : !existsSync(join(PLUGINS_DIR, "package.json"))
        ? `pi-plugins not found at ${PLUGINS_DIR}`
        : null);
  if (required) {
    if (reason) throw new Error(`Required plugin compatibility: ${reason}`);
    requirePi();
  }
  return reason;
}

/** A successful fenced read proves configuration, not merely an advertised hello. */
export async function resourceSnapshot(h: CompatHarness, s: CompatSession) {
  const live = h.agent.supervisor.managedSession(s.id)!;
  const hello = live.bridgeFeatures;
  expect(hello?.capabilities.resourceSnapshot).toBe(true);
  const snapshot = await live.resources();
  expect(snapshot).toMatchObject({
    cwd: h.pi.cwd,
    runtimeId: hello!.runtimeId,
    nativeSessionId: hello!.nativeSessionId,
    bindingId: expect.any(String),
  });
  expect(snapshot.bindingId).not.toBe("");
  expect(live.bridgeFeatures).toEqual(hello);
  return snapshot;
}

/** Resource inspection and effective trust/source provenance are separate capabilities. */
export async function effectiveResourcesSupported(h: CompatHarness, s: CompatSession) {
  const snapshot = await resourceSnapshot(h, s);
  const result = h.agent.supervisor.sessionAdapters(s.id);
  expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  const legacy = result.diagnostics.some((d) => /legacy user-scope/i.test(d.message));
  if (legacy) {
    // Only an actual missing trust API may explain this supported-version fallback.
    // In particular, a failed configure/resolver must never escape the 1.5 assertions.
    const evidence = JSON.stringify({ snapshot, diagnostics: result.diagnostics });
    expect(requirePi(), evidence).toMatch(/^1\.4\./);
    expect(snapshot.projectTrusted, evidence).toBeNull();
    expectLegacyDiscovery(result);
    return false;
  }
  expect(snapshot.projectTrusted).not.toBeNull();
  const reported = new Set(snapshot.reportedExtensionPaths.map((path) => realpathSync(path)));
  for (const adapter of result.adapters.filter((a) => a.runtimeStatus === "active")) {
    if (adapter.provenance.scope === "project") expect(snapshot.projectTrusted).toBe(true);
    if (adapter.provenance.evidence === "runtime-reported") {
      expect(adapter.provenance.entrypoints.some((path) => reported.has(realpathSync(path)))).toBe(
        true,
      );
    }
  }
  return true;
}

export function expectLegacyDiscovery(result: SessionAdaptersResult): void {
  expect(result.diagnostics.some((d) => /legacy user-scope/i.test(d.message))).toBe(true);
  expect(
    result.adapters.filter((a) => a.provenance.scope === "project" && a.runtimeStatus === "active"),
  ).toEqual([]);
}

/** True only for the explicitly unsupported bound-adapter case, never a 1.5 failure escape. */
export async function legacyBoundAdapter(
  h: CompatHarness,
  s: CompatSession,
  plugin: PluginName,
  id: string,
): Promise<boolean> {
  if (await effectiveResourcesSupported(h, s)) return false;
  const manifest = JSON.parse(
    readFileSync(join(pluginDir(plugin), "src/switchyard/switchyard-adapter.json"), "utf8"),
  );
  if (!manifest.target?.entrypoints?.length) return false;
  const result = h.agent.supervisor.sessionAdapters(s.id);
  expectLegacyDiscovery(result);
  expect(result.adapters.find((a) => a.id === id)).toMatchObject({
    status: "disabled",
    runtimeStatus: "disabled",
    provenance: { evidence: "runtime-reported" },
  });
  expect(s.panels().filter((p) => p.adapterId === id)).toEqual([]);
  return true;
}

/**
 * Raw payloads and results per test. `.tmp*` is ignored by both git and biome (repo convention
 * for scratch output), so recorded JSON never trips the formatter.
 */
export const RESULTS_DIR = fileURLToPath(new URL("./.tmp-results/", import.meta.url));

export interface PluginInfo {
  commit: string | null;
  /** Per package: true when the pi-plugins working tree has uncommitted changes in it. */
  dirty: Record<string, boolean | null>;
  versions: Record<string, string | null>;
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", PLUGINS_DIR, ...args], { encoding: "utf8" }).trim();

export function pluginInfo(names: PluginName[]): PluginInfo {
  let commit: string | null = null;
  try {
    commit = git("rev-parse", "HEAD");
  } catch {
    // not a git checkout
  }
  const versions: Record<string, string | null> = {};
  const dirty: Record<string, boolean | null> = {};
  for (const n of names) {
    let key: string = n;
    try {
      const pkg = JSON.parse(readFileSync(join(pluginDir(n), "package.json"), "utf8"));
      key = pkg.name ?? n;
      versions[key] = pkg.version ?? null;
    } catch {
      versions[key] = null;
    }
    try {
      dirty[key] = commit ? git("status", "--porcelain", "--", `packages/${n}`) !== "" : null;
    } catch {
      dirty[key] = null;
    }
  }
  return { commit, dirty, versions };
}

/** Write a result record under `.tmp-results/<name>.json` for docs/compatibility.md. */
export function recordResult(name: string, data: Record<string, unknown>): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `${name}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), piVersion: requirePi(), ...data }, null, 2)}\n`,
  );
}

export interface CompatHarness {
  coord: FakeCoordinator;
  agent: HostAgentHandle;
  mock: MockModelServer;
  pi: PiEnv;
  /** Actual suite used by this harness (a writable temp copy when requested). */
  suiteDir: string;
  /** The active adapter `id` from the host's latest `adapters.updated` event. */
  adapter(id: string): AdapterInfo | undefined;
  /** Start a session in the isolated Pi cwd, recording every raw Pi UI request. */
  startSession(): Promise<CompatSession>;
  startEnrolledSession(): Promise<
    CompatSession & { terminal: { write(keys: string): void; output(): string } }
  >;
  dispose(): Promise<void>;
}

export interface CompatSession {
  id: string;
  /** Raw `extension_ui_request` payloads as Pi sent them. */
  uiRequests: any[];
  /** Every `extension_ui_response` body the host wrote to Pi. */
  uiResponses: { id: string; body: any }[];
  /** Raw Pi session events (tool_execution_*, entry_appended, message_end, ...). */
  piEvents: any[];
  /** Raw `tool_execution_end` events for `name`. */
  toolEnds(name: string): any[];
  prompt(text: string): Promise<unknown>;
  interactions(): Interaction[];
  /** Latest state of each interaction, in creation order. */
  latestInteractions(): Interaction[];
  items(): TranscriptItem[];
  /** Latest version of each transcript item, in first-seen order. */
  latestItems(): TranscriptItem[];
  panels(): Panel[];
  settledCount(): number;
  waitSettled(after: number, timeoutMs?: number): Promise<void>;
  answer(
    i: Interaction,
    response: Extract<HostCommand, { type: "session.answer" }>["response"],
  ): Promise<any>;
}

type TestPty = {
  onData(fn: (data: string) => void): void;
  onExit(fn: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(): void;
};
type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): TestPty;
};

let n = 0;

/** Credentials that would let a plugin call a network model (System 1 judges, classifiers). */
export const NETWORK_CREDENTIALS = [
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
];

export async function startCompatHarness(opts: {
  plugins: PluginName[];
  script: MockScript;
  settings?: Record<string, unknown>;
  /** Explicit settings override the default user-scope package entry. */
  userPackages?: unknown[];
  projectPackages?: unknown[];
  projectSettings?: Record<string, unknown>;
  projectTrust?: Profile["projectTrust"];
  terminalSessions?: boolean;
  /** Copy sources into the temp root; dependency symlinks remain read-only test inputs. */
  writableSuite?: boolean;
  /** Write extra files into the isolated agent dir before Pi starts. */
  agentFiles?: Record<string, string>;
  /**
   * Give Pi an empty temp HOME (default true), so user-level plugin config (~/.config/...),
   * skills (~/.agents) and plugin state outside PI_CODING_AGENT_DIR (pi-bg's ~/.pi/agent/bg)
   * stay inside the test.
   */
  isolateHome?: boolean;
}): Promise<CompatHarness> {
  requirePi();
  const coord = await FakeCoordinator.start();
  if (opts.terminalSessions) coord.welcomeFeatures = [ADAPTER_CONTRACT_FEATURE];
  const state = tempDir("switchyard-compat-");
  const mock = await startMockModel(opts.script);
  const suiteDir = opts.writableSuite ? join(state.path, "pi-plugins") : PLUGINS_DIR;
  if (opts.writableSuite) {
    cpSync(PLUGINS_DIR, suiteDir, {
      recursive: true,
      filter: (source) =>
        !source.split(/[\\/]/).some((part) => [".git", "node_modules"].includes(part)),
    });
    for (const dir of ["", ...opts.plugins.map((name) => `packages/${name}`)]) {
      const modules = join(PLUGINS_DIR, dir, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(suiteDir, dir, "node_modules"), "dir");
    }
  }
  const pi = makePiEnv({
    mockUrl: mock.url,
    settings: {
      ...opts.settings,
      packages:
        opts.userPackages ?? (opts.projectPackages ? [] : pluginPackages(opts.plugins, suiteDir)),
    },
  });
  if (opts.projectPackages || opts.projectSettings) {
    mkdirSync(join(pi.cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(pi.cwd, ".pi", "settings.json"),
      JSON.stringify({
        ...opts.projectSettings,
        ...(opts.projectPackages ? { packages: opts.projectPackages } : {}),
      }),
    );
  }
  for (const [rel, content] of Object.entries(opts.agentFiles ?? {})) {
    const p = join(pi.agentDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  // No network judges or classifiers: blank the credentials plugins could find in our environment.
  for (const k of NETWORK_CREDENTIALS) pi.env[k] = "";
  // A headless worker may inherit its parent's workflow policy. Fixtures are independent
  // top-level sessions; real plugin-spawned children set their own inheritance afterwards.
  for (const key of [
    "PI_SUBAGENT",
    "PI_SUBAGENT_DEPTH",
    "PI_TOOL_GATE_APPROVAL",
    "PI_TOOL_GATE_WORKFLOW",
    "PI_TOOL_GATE_SCRATCH",
    "PI_TOOL_GATE_DENY_INSTEAD_OF_PROMPTING",
  ])
    pi.env[key] = "";
  if (opts.isolateHome !== false) {
    const home = join(pi.root, "home");
    mkdirSync(home, { recursive: true });
    pi.env.HOME = home;
    pi.env.XDG_CONFIG_HOME = join(home, ".config");
    pi.env.XDG_STATE_HOME = join(home, ".local", "state");
  }
  // No `-e` extensions and no bundled adapters: Pi loads the plugins from the settings.json
  // package entry and the host loads their adapters through the plugin tier.
  const agent = await runHostAgent({
    config: {
      coordinatorUrl: coord.url,
      hostId: "hst_compat",
      credential: "secret",
      name: "compat host",
    },
    stateDir: state.path,
    piBin: piBin(),
    env: pi.env,
    ownerAdapterDir: join(state.path, "owner-adapters"),
    handleSignals: false,
    terminalSessions: opts.terminalSessions ?? false,
    backoffMs: [50, 100, 200],
    logger: silentLogger(),
  });
  await coord.waitUntil(() => coord.connected, 10000, "host hello");

  const ofSession = <T>(type: string, id: string) =>
    coord.eventsOf(type, id).map((e: HostEvent) => (e as { data: T }).data);
  const latestById = <T extends { id: string }>(xs: T[]): T[] => {
    const m = new Map<string, T>();
    for (const x of xs) m.set(x.id, x);
    return [...m.values()];
  };

  const terminals = new Set<TestPty>();
  const captureSession = (id: string): CompatSession => {
    const ms = agent.supervisor.managedSession(id);
    if (!ms) throw new Error("no managed session");
    const uiRequests: any[] = [];
    const uiResponses: { id: string; body: any }[] = [];
    const piEvents: any[] = [];
    ms.on("ui_request", (r: unknown) => uiRequests.push(structuredClone(r)));
    ms.on("pi_event", (e: unknown) => piEvents.push(structuredClone(e)));
    const proc = ms.process!;
    const respondUi = proc.respondUi.bind(proc);
    proc.respondUi = ((reqId: string, body: any) => {
      uiResponses.push({ id: reqId, body: structuredClone(body) });
      return respondUi(reqId, body);
    }) as typeof proc.respondUi;
    const settledCount = () =>
      coord
        .eventsOf("session.updated", id)
        .filter((e) => (e.data as { settled?: unknown }).settled != null).length;
    const s: CompatSession = {
      id,
      uiRequests,
      uiResponses,
      piEvents,
      toolEnds: (name) =>
        piEvents.filter((e) => e.type === "tool_execution_end" && e.toolName === name),
      prompt: (text) =>
        coord.ok({
          type: "session.prompt",
          sessionId: id,
          text,
          images: [],
          mode: "prompt",
          origin: "human",
          controlRevision: 1,
        }),
      interactions: () => ofSession<Interaction>("interaction.updated", id),
      latestInteractions: () => latestById(s.interactions()),
      items: () => ofSession<TranscriptItem>("transcript.item", id),
      latestItems: () => latestById(s.items()),
      panels: () => agent.supervisor.panels(id),
      settledCount,
      waitSettled: (after, timeoutMs = 60000) =>
        coord.waitUntil(() => settledCount() > after, timeoutMs, "run settled"),
      answer: (i, response) =>
        coord.ok({
          type: "session.answer",
          sessionId: id,
          interactionId: i.id,
          revision: i.revision,
          response,
          deviceId: "dev_compat",
        }),
    };
    return s;
  };

  return {
    coord,
    agent,
    mock,
    pi,
    suiteDir,
    adapter(id) {
      const last = coord.eventsOf("adapters.updated").at(-1)?.data as
        | { adapters: AdapterInfo[] }
        | undefined;
      return last?.adapters.find((a) => a.id === id && a.status === "active");
    },
    async startSession() {
      const id = `ses_compat${Date.now()}${++n}`;
      await coord.ok(
        startCommand(id, pi.cwd, {
          profile: { ...mockProfile, projectTrust: opts.projectTrust ?? "approve" },
        }),
      );
      return captureSession(id);
    },
    async startEnrolledSession() {
      if (!opts.terminalSessions || !terminalSupport().ok)
        throw new Error("terminal support required");
      const pty = createRequire(import.meta.resolve("@switchyard/pi-runtime"))(
        "node-pty",
      ) as PtyModule;
      const env = {
        PATH: process.env.PATH ?? "",
        ...pi.env,
        TERM: "xterm-256color",
        SWITCHYARD_ENROLL_STATE_DIR: state.path,
        SWITCHYARD_ENROLL: "1",
      };
      delete env.SWITCHYARD_CONTROL_SOCKET;
      delete env.SWITCHYARD_BRIDGE_SOCKET;
      const existing = new Set(coord.eventsOf("session.updated").map((e) => e.sessionId));
      const proc = pty.spawn(
        piBin(),
        ["--provider", "mock", "--model", "mock-1", "-e", terminalExtensionPath()],
        {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: pi.cwd,
          env,
        },
      );
      terminals.add(proc);
      let output = "";
      proc.onData((data) => {
        output = (output + data).slice(-100000);
      });
      let exit: { exitCode: number; signal?: number } | undefined;
      proc.onExit((event) => {
        exit = event;
        terminals.delete(proc);
      });
      let id: string | undefined;
      await coord
        .waitUntil(
          () => {
            const event = coord.eventsOf("session.updated").find((e) => {
              const snapshot = e.data as {
                external?: unknown;
                terminal?: boolean;
                runtime?: string;
              };
              return (
                !existing.has(e.sessionId) &&
                !!snapshot.external &&
                snapshot.terminal === false &&
                snapshot.runtime === "idle"
              );
            });
            id = event?.sessionId;
            return !!id && !!agent.supervisor.managedSession(id);
          },
          30000,
          "enrolled session idle",
        )
        .catch((err) => {
          throw new Error(
            `${err.message}\nExit: ${JSON.stringify(exit)}\nPTY: ${output.slice(-4000)}`,
          );
        });
      return {
        ...captureSession(id!),
        terminal: { write: (keys) => proc.write(keys), output: () => output },
      };
    },
    async dispose() {
      for (const proc of terminals) {
        try {
          proc.kill();
        } catch {
          /* already exited */
        }
      }
      await agent.stop({ terminals: "stop" }).catch(() => {});
      await coord.close();
      await mock.close();
      pi.cleanup();
      state.cleanup();
    },
  };
}

/** Tool definition (`function` object) Pi declared to the model, from recorded requests. */
export function declaredTool(mock: MockModelServer, name: string): any {
  for (const r of mock.requests) {
    const t = (r.body?.tools ?? []).find((t: any) => (t?.function?.name ?? t?.name) === name);
    if (t) return t.function ?? t;
  }
  return undefined;
}

/** Last tool transcript item for `name` (latest version). */
export function toolItem(s: CompatSession, name: string) {
  return s
    .latestItems()
    .filter((i): i is Extract<TranscriptItem, { kind: "tool" }> => i.kind === "tool")
    .filter((i) => i.data.name === name)
    .at(-1);
}
