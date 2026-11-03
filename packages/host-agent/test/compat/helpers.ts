import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterInfo,
  HostCommand,
  HostEvent,
  Interaction,
  Panel,
  TranscriptItem,
} from "@switchyard/protocol";
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
import { type HostAgentHandle, runHostAgent, silentLogger } from "../../src/index.js";
import { FakeCoordinator, startCommand, tempDir, waitFor } from "../helpers.js";

export { waitFor };

/** Root of a pi-plugins checkout (`SWITCHYARD_PI_PLUGINS_DIR`); the tests skip when it is unset. */
export const PLUGINS_DIR = process.env.SWITCHYARD_PI_PLUGINS_DIR ?? "";

export type PluginName =
  | "pi-ask-user-question"
  | "pi-tool-gate"
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
export function pluginPackages(plugins: PluginName[]) {
  return [
    {
      source: PLUGINS_DIR,
      extensions: plugins.map(pluginExtension),
      skills: [],
      prompts: [],
      themes: [],
    },
  ];
}

/** Why the compat tests skip, or null when they must run. */
export function compatSkipReason(): string | null {
  const real = realPiSkipReason();
  if (real) return real;
  if (!PLUGINS_DIR) return "SWITCHYARD_PI_PLUGINS_DIR is not set";
  if (!existsSync(PLUGINS_DIR)) return `pi-plugins not found at ${PLUGINS_DIR}`;
  return null;
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
  /** The active adapter `id` from the host's latest `adapters.updated` event. */
  adapter(id: string): AdapterInfo | undefined;
  /** Start a session in the isolated Pi cwd, recording every raw Pi UI request. */
  startSession(): Promise<CompatSession>;
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
  const state = tempDir("switchyard-compat-");
  const mock = await startMockModel(opts.script);
  const pi = makePiEnv({
    mockUrl: mock.url,
    settings: { ...opts.settings, packages: pluginPackages(opts.plugins) },
  });
  for (const [rel, content] of Object.entries(opts.agentFiles ?? {})) {
    const p = join(pi.agentDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  // No network judges or classifiers: blank the credentials plugins could find in our environment.
  for (const k of NETWORK_CREDENTIALS) pi.env[k] = "";
  if (opts.isolateHome !== false) {
    const home = join(pi.root, "home");
    mkdirSync(home, { recursive: true });
    pi.env.HOME = home;
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

  return {
    coord,
    agent,
    mock,
    pi,
    adapter(id) {
      const last = coord.eventsOf("adapters.updated").at(-1)?.data as
        | { adapters: AdapterInfo[] }
        | undefined;
      return last?.adapters.find((a) => a.id === id && a.status === "active");
    },
    async startSession() {
      const id = `ses_compat${Date.now()}${++n}`;
      await coord.ok(startCommand(id, pi.cwd));
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
    },
    async dispose() {
      await agent.stop().catch(() => {});
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
