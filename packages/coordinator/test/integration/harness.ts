/**
 * Cross-package integration harness: a real coordinator (temp data dir, port 0), a real host agent
 * (temp config and state dirs) running the installed Pi against the scripted mock model, a temp
 * git repository registered as a project, and enrolled client devices (terminal bearer, browser
 * and PWA cookies).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enroll, type HostAgentHandle, runHostAgent, silentLogger } from "@switchyard/host-agent";
import type {
  EventEnvelope,
  HostCommand,
  Interaction,
  PushPayload,
  Run,
  ServerToClient,
  Session,
  Task,
} from "@switchyard/protocol";
import {
  fixtureExtensionPath,
  type MockModelServer,
  type MockReply,
  type MockRequest,
  type MockScript,
  makePiEnv,
  makeRepo,
  type PiEnv,
  piBin,
  requirePi,
  startMockModel,
  type TempRepo,
} from "@switchyard/test-fixtures";
import { WebSocket } from "ws";
import {
  type Coordinator,
  type CreateCoordinatorOptions,
  createCoordinator,
  createLogger,
  type PushTarget,
} from "../../src/index.js";

// ---- small utilities --------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `pred` until it holds. */
export async function waitFor(
  pred: () => boolean,
  label = "condition",
  timeoutMs = 30_000,
  stepMs = 25,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

/** Poll an async producer until it returns a non-undefined value. */
export async function waitForValue<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  label = "value",
  timeoutMs = 30_000,
  stepMs = 25,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Switchyard Test",
      GIT_AUTHOR_EMAIL: "test@switchyard.invalid",
      GIT_COMMITTER_NAME: "Switchyard Test",
      GIT_COMMITTER_EMAIL: "test@switchyard.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** Worktree paths of a repository (`git worktree list --porcelain`), main checkout first. */
export function worktreePaths(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Every `.jsonl` file below `dir` (Pi session files). */
export function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

// ---- mock model -------------------------------------------------------------------------------

export const DONE_TEXT = "Finished the work.\nSWITCHYARD: DONE";
export const NO_MARKER_TEXT = "Still working on it.";

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n");
  }
  return "";
}

/**
 * Step-driven script. The latest user message may contain `STEPS: a,b,c`; the n-th model call
 * after it (counted by tool results) performs step n:
 * - `select` / `confirm` / `gate`: call `fixture_select` / `fixture_confirm` / `fixture_gate`
 * - `slow:<ms>`: call `fixture_slow {ms}`
 * - `done`: answer with text ending in `SWITCHYARD: DONE`
 * - `talk`: answer with text without a marker
 * Without `STEPS:` the model answers without a marker.
 */
export function stepReply(req: MockRequest): MockReply {
  let lastUser = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  const text = lastUser >= 0 ? messageText(req.messages[lastUser]) : "";
  const m = text.match(/STEPS:[ \t]*([^\n]+)/);
  if (!m) return { text: NO_MARKER_TEXT };
  const steps = m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const done = req.messages.slice(lastUser + 1).filter((x: any) => x?.role === "tool").length;
  const step = steps[done] ?? "done";
  const call = (name: string, args: Record<string, unknown> = {}): MockReply => ({
    toolCalls: [{ name, arguments: args }],
  });
  if (step === "select") return call("fixture_select");
  if (step === "confirm") return call("fixture_confirm");
  if (step === "gate") return call("fixture_gate");
  if (step.startsWith("slow:")) return call("fixture_slow", { ms: Number(step.slice(5)) });
  if (step === "talk") return { text: NO_MARKER_TEXT };
  return { text: DONE_TEXT };
}

export const stepScript: MockScript = [{ when: () => true, reply: stepReply }];

// ---- Pi extension_ui_response recorder --------------------------------------------------------

export interface UiResponseRecord {
  pid: number | undefined;
  id: string;
  body: unknown;
}

/** Every `extension_ui_response` written to any Pi process (after `trackUiResponses`). */
export const uiResponses: UiResponseRecord[] = [];

/**
 * Patch the Pi RPC process class (shared by every Pi process of this worker) to record each
 * `extension_ui_response` it writes. Call with any live process; idempotent.
 */
export function trackUiResponses(proc: object): void {
  const proto = Object.getPrototypeOf(proc) as {
    respondUi: (id: string, body: unknown) => Promise<void>;
    __syRecorded?: boolean;
  };
  if (proto.__syRecorded) return;
  const orig = proto.respondUi;
  proto.respondUi = function (this: { pid?: number }, id: string, body: unknown) {
    uiResponses.push({ pid: this.pid, id, body });
    return orig.call(this, id, body);
  };
  proto.__syRecorded = true;
}

// ---- clients -----------------------------------------------------------------------------------

export type DeviceKind = "browser" | "pwa" | "terminal" | "cli";

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  /** Bearer credential (terminal/cli). */
  credential: string | null;
  /** `sy_device=<credential>` (browser/pwa). */
  cookie: string | null;
}

export type As = Device | "admin" | "anonymous";

export interface ApiResult {
  status: number;
  body: any;
}

/** A `/ws/client` connection collecting every frame. */
export class WsClient {
  readonly messages: ServerToClient[] = [];
  closeCode: number | null = null;
  ws!: WebSocket;

  /** Durable events received live or by replay, in arrival order. */
  get events(): EventEnvelope[] {
    return this.messages.flatMap((m) =>
      m.type === "event" ? [m.event] : m.type === "replay" ? m.events : [],
    );
  }

  get lastSeq(): number {
    let seq = 0;
    for (const m of this.messages) {
      if (m.type === "event") seq = Math.max(seq, m.event.seq);
      else if (m.type === "replay" || m.type === "snapshot") seq = Math.max(seq, m.seq);
    }
    return seq;
  }

  static async open(url: string, headers: Record<string, string>): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws/client`, { headers });
    c.ws.on("message", (raw) => c.messages.push(JSON.parse(raw.toString())));
    c.ws.on("close", (code) => {
      c.closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
      c.ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`unexpected-response ${res.statusCode}`)),
      );
    });
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  async hello(cursor: number | null = null): Promise<void> {
    const from = this.messages.length;
    this.send({ type: "hello", cursor });
    await waitFor(
      () => this.messages.slice(from).some((m) => m.type === "replay" || m.type === "snapshot"),
      "client sync",
      10_000,
    );
  }

  presence(p: {
    foreground: boolean;
    interactedAt: string | null;
    viewing: { sessionId: string } | null;
  }): void {
    this.send({ type: "presence", presence: p });
  }

  /** Wait for an event frame matching `pred`. */
  async waitEvent(
    pred: (e: EventEnvelope) => boolean,
    label = "event",
    timeoutMs = 30_000,
  ): Promise<EventEnvelope> {
    let found: EventEnvelope | undefined;
    await waitFor(
      () => {
        found = this.events.find(pred);
        return !!found;
      },
      label,
      timeoutMs,
    );
    return found!;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // closed
    }
  }
}

// ---- the environment ---------------------------------------------------------------------------

export interface PushRecord {
  endpoint: string;
  payload: PushPayload;
}

export interface IntegrationOptions {
  /** Start the host agent with real Pi (default true). */
  withHost?: boolean;
  script?: MockScript;
  /** Extra `-e` extensions in addition to the fixture extension. */
  extraExtensions?: string[];
  coordinator?: Partial<CreateCoordinatorOptions>;
  /** Prepare the repository before the project is registered. */
  prepareRepo?: (path: string) => void;
  project?: { checks?: string[]; maxConcurrentRuns?: number };
}

export class Integration {
  c!: Coordinator;
  readonly dataDir = tempDir("sy-int-coord-");
  readonly stateDir = tempDir("sy-int-host-");
  readonly configPath: string;
  readonly ownerAdapterDir: string;
  port = 0;
  /** Added to wall time for the coordinator clock. */
  clockOffsetMs = 0;
  mock: MockModelServer | null = null;
  pi: PiEnv | null = null;
  repo: TempRepo | null = null;
  agent: HostAgentHandle | null = null;
  readonly agents: HostAgentHandle[] = [];
  hostId = "";
  /** Every command the host agent(s) received, in order, including duplicates. */
  readonly hostCommands: HostCommand[] = [];
  /** Mutable test hooks forwarded to the host agent. */
  readonly hooks: { dropReceipt?: (commandId: string, command: HostCommand) => boolean } = {};
  readonly pushes: PushRecord[] = [];
  readonly clients: WsClient[] = [];
  project: any = null;
  devices: { terminal: Device; desktop: Device; mobile: Device } | null = null;
  private running = false;

  constructor(private readonly opts: IntegrationOptions = {}) {
    this.configPath = join(this.stateDir, "config", "host.json");
    this.ownerAdapterDir = join(this.stateDir, "owner-adapters");
    mkdirSync(this.ownerAdapterDir, { recursive: true });
  }

  static async create(opts: IntegrationOptions = {}): Promise<Integration> {
    const env = new Integration(opts);
    try {
      await env.init();
    } catch (err) {
      await env.dispose();
      throw err;
    }
    return env;
  }

  private async init(): Promise<void> {
    await this.startCoordinator();
    const terminal = await this.enrollDevice("terminal", "Terminal");
    const desktop = await this.enrollDevice("browser", "Desktop browser");
    const mobile = await this.enrollDevice("pwa", "Phone");
    this.devices = { terminal, desktop, mobile };
    if (this.opts.withHost === false) return;
    requirePi();
    this.mock = await startMockModel(this.opts.script ?? stepScript);
    this.pi = makePiEnv({ mockUrl: this.mock.url });
    this.repo = makeRepo();
    this.opts.prepareRepo?.(this.repo.path);
    // Host enrollment through the admin API and the host agent's own `enroll()`.
    const e = await this.api("POST", "/api/hosts/enrollments", { as: "admin" });
    if (e.status !== 201) throw new Error(`host enrollment: ${JSON.stringify(e.body)}`);
    const cfg = await enroll({
      coordinatorUrl: this.c.localUrl,
      token: e.body.token,
      name: "nuc",
      configPath: this.configPath,
    });
    this.hostId = cfg.hostId;
    await this.startAgent();
    const p = await this.api("POST", "/api/projects", {
      as: "admin",
      body: {
        name: "Repo",
        hostId: this.hostId,
        path: this.repo.path,
        checks: this.opts.project?.checks ?? [],
        maxConcurrentRuns: this.opts.project?.maxConcurrentRuns ?? 1,
      },
    });
    if (p.status !== 201) throw new Error(`project: ${JSON.stringify(p.body)}`);
    this.project = p.body;
  }

  get url(): string {
    return this.c.localUrl;
  }

  // ---- coordinator lifecycle ----

  async startCoordinator(): Promise<void> {
    const pushes = this.pushes;
    this.c = createCoordinator({
      dataDir: this.dataDir,
      listen: { host: "127.0.0.1", port: this.port },
      logger: createLogger({ level: process.env.SY_LOG ?? "silent" }),
      clock: () => new Date(Date.now() + this.clockOffsetMs),
      dispatcher: { tickMs: 100, reconcileEveryMs: 1000, retryBackoffMs: 1000 },
      schedulerTickMs: 0,
      pushSender: async (sub: PushTarget, payload: PushPayload) => {
        pushes.push({ endpoint: sub.endpoint, payload });
      },
      ...this.opts.coordinator,
    });
    await this.c.start();
    this.port = this.c.port;
    this.running = true;
  }

  async stopCoordinator(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const cl of this.clients) cl.close();
    await this.c.stop();
  }

  /** Stop and start the coordinator on the same data dir and port. */
  async restartCoordinator(): Promise<void> {
    await this.stopCoordinator();
    await this.startCoordinator();
  }

  // ---- host lifecycle ----

  async startAgent(): Promise<HostAgentHandle> {
    const agent = await runHostAgent({
      configPath: this.configPath,
      stateDir: this.stateDir,
      piBin: piBin(),
      env: this.pi!.env,
      extraExtensions: [fixtureExtensionPath(), ...(this.opts.extraExtensions ?? [])],
      ownerAdapterDir: this.ownerAdapterDir,
      handleSignals: false,
      backoffMs: [50, 100, 200],
      logger: silentLogger(),
      testHooks: {
        dropReceipt: (id, cmd) => this.hooks.dropReceipt?.(id, cmd) ?? false,
        onCommand: (cmd) => {
          this.hostCommands.push(cmd);
        },
      },
    });
    this.agent = agent;
    this.agents.push(agent);
    await this.waitHostConnected();
    return agent;
  }

  async waitHostConnected(timeoutMs = 20_000): Promise<void> {
    await waitFor(
      () => this.running && this.c.hostHub.isConnected(this.hostId) && !!this.agent?.link.connected,
      "host connected",
      timeoutMs,
    );
  }

  // ---- devices and API ----

  async enrollDevice(kind: DeviceKind, name: string): Promise<Device> {
    const e = await this.api("POST", "/api/enrollments", {
      as: "admin",
      body: { kind: "device" },
    });
    if (e.status !== 201) throw new Error(`enrollment: ${JSON.stringify(e.body)}`);
    const res = await fetch(`${this.url}/api/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: e.body.token, name, kind }),
    });
    const body = (await res.json()) as { deviceId: string; credential: string };
    if (res.status !== 201) throw new Error(`enroll: ${JSON.stringify(body)}`);
    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie ? setCookie.split(";")[0]! : null;
    const browser = kind === "browser" || kind === "pwa";
    if (browser && !cookie) throw new Error("browser enrollment set no cookie");
    return {
      id: body.deviceId,
      kind,
      name,
      credential: browser ? null : body.credential,
      cookie: browser ? cookie : null,
    };
  }

  headersFor(as: As, method = "GET"): Record<string, string> {
    if (as === "anonymous") return {};
    if (as === "admin") return { authorization: `Bearer ${this.c.adminToken}` };
    if (as.cookie) {
      const h: Record<string, string> = { cookie: as.cookie };
      if (method !== "GET" && method !== "HEAD") {
        h["x-switchyard-request"] = "1";
        h.origin = this.url;
      }
      return h;
    }
    return { authorization: `Bearer ${as.credential}` };
  }

  async api(
    method: string,
    path: string,
    opts: { as?: As; body?: unknown } = {},
  ): Promise<ApiResult> {
    const headers = this.headersFor(opts.as ?? "admin", method);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body };
  }

  /** `api` that throws unless the status is 2xx. */
  async ok(method: string, path: string, opts: { as?: As; body?: unknown } = {}): Promise<any> {
    const r = await this.api(method, path, opts);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body;
  }

  /** Open a synced client socket for a device. */
  async connect(device: Device): Promise<WsClient> {
    const headers = this.headersFor(device);
    if (device.cookie) headers.origin = this.url;
    const cl = await WsClient.open(this.url, headers);
    this.clients.push(cl);
    await cl.hello(null);
    return cl;
  }

  // ---- state helpers ----

  get mainWorkspaceId(): string {
    const ws = this.c.store.workspaces
      .list("project_id = ?", [this.project.id])
      .find((w) => w.provenance === "main");
    if (!ws) throw new Error("no main workspace");
    return ws.id;
  }

  get checkoutId(): string {
    return this.c.store.checkouts.list("project_id = ?", [this.project.id])[0]!.id;
  }

  task(id: string): Task {
    return this.c.store.tasks.require(id);
  }

  run(taskId: string): Run | undefined {
    const t = this.c.store.tasks.get(taskId);
    return t?.currentRunId ? this.c.store.runs.get(t.currentRunId) : undefined;
  }

  session(id: string): Session {
    return this.c.store.sessions.require(id);
  }

  async waitRun(
    taskId: string,
    pred: (r: Run) => boolean,
    label: string,
    timeoutMs = 60_000,
  ): Promise<Run> {
    await waitFor(
      () => {
        const r = this.run(taskId);
        return !!r && pred(r);
      },
      label,
      timeoutMs,
    );
    return this.run(taskId)!;
  }

  async waitTaskState(taskId: string, state: Task["state"], timeoutMs = 60_000): Promise<Task> {
    await waitFor(
      () => this.c.store.tasks.get(taskId)?.state === state,
      `task ${state}`,
      timeoutMs,
    );
    return this.task(taskId);
  }

  async waitSession(
    id: string,
    pred: (s: Session) => boolean,
    label: string,
    timeoutMs = 60_000,
  ): Promise<Session> {
    await waitFor(
      () => {
        const s = this.c.store.sessions.get(id);
        return !!s && pred(s);
      },
      label,
      timeoutMs,
    );
    return this.session(id);
  }

  /** The pending interaction of a session (waits for one). */
  async pendingInteraction(sessionId: string, timeoutMs = 60_000): Promise<Interaction> {
    return waitForValue(
      () =>
        this.c.store.interactions
          .list("session_id = ? AND state = 'pending'", [sessionId], "created_at")
          .at(-1),
      "pending interaction",
      timeoutMs,
    );
  }

  /** Create a plain session in the main checkout and wait until Pi is up. */
  async createSession(as: As, prompt = "", title = "Integration session"): Promise<Session> {
    const s = await this.ok("POST", "/api/sessions", {
      as,
      body: {
        projectId: this.project.id,
        workspace: { existingId: this.mainWorkspaceId },
        prompt,
        title,
      },
    });
    await this.waitSession(s.id, (x) => x.nativeHandle !== null, "session started");
    return this.session(s.id);
  }

  /** Wait until a session's Pi process is live on the host and record its UI responses. */
  async livePi(sessionId: string): Promise<number> {
    const proc = await waitForValue(
      () => this.agent!.supervisor.managedSession(sessionId)?.process ?? undefined,
      "live Pi process",
    );
    trackUiResponses(proc);
    return proc.pid!;
  }

  /** Host outbox rows (sent and unsent) carrying a settle for the session. */
  hostSettles(sessionId: string): number {
    return this.agent!.link.pending(0).filter(
      (r) =>
        r.event.type === "session.updated" &&
        r.event.sessionId === sessionId &&
        (r.event.data as { settled?: unknown }).settled != null,
    ).length;
  }

  commandsOf<T extends HostCommand["type"]>(type: T): Extract<HostCommand, { type: T }>[] {
    return this.hostCommands.filter((c) => c.type === type) as never;
  }

  async createTask(as: As, body: Record<string, unknown>): Promise<Task> {
    return this.ok("POST", "/api/tasks", {
      as,
      body: { projectId: this.project.id, acceptanceCriteria: [], ...body },
    });
  }

  async dispose(): Promise<void> {
    for (const cl of this.clients) cl.close();
    for (const a of this.agents) await a.stop().catch(() => {});
    if (this.running) await this.stopCoordinator().catch(() => {});
    await this.mock?.close().catch(() => {});
    this.pi?.cleanup();
    if (this.repo) {
      // Worktrees outside the repo (external discovery) are removed by their tests.
      this.repo.cleanup();
    }
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.stateDir, { recursive: true, force: true });
  }
}

/** A run prompt that drives the step script. */
export function steps(...s: string[]): string {
  return `STEPS: ${s.join(",")}`;
}
