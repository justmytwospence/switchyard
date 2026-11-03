import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoordinatorToHost,
  type HostCommand,
  type HostEvent,
  HostToCoordinator,
  newId,
  type Profile,
  type Receipt,
  type TermCoordinatorMsg,
  type TermServerToViewer,
} from "@switchyard/protocol";
import {
  fixtureExtensionPath,
  type MockModelServer,
  type MockScript,
  makePiEnv,
  type PiEnv,
  piBin,
  requirePi,
  startMockModel,
} from "@switchyard/test-fixtures";
import { WebSocket, WebSocketServer } from "ws";
import {
  type HostAgentHandle,
  type HostTestHooks,
  runHostAgent,
  silentLogger,
} from "../src/index.js";

export const mockProfile: Profile = {
  id: "prf_mock",
  name: "Mock",
  provider: "mock",
  model: "mock-1",
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};

export interface ReceivedEvent {
  hostSeq: number;
  event: HostEvent;
}

/** A minimal coordinator speaking the host wire protocol over `/ws/host`. */
export class FakeCoordinator {
  readonly events: ReceivedEvent[] = [];
  readonly hellos: Extract<HostToCoordinator, { type: "hello" }>[] = [];
  readonly receipts: Receipt[] = [];
  readonly term: { streamId: string; msg: TermServerToViewer }[] = [];
  /** Cumulative ack, kept across restarts of this fake. */
  ackedHostSeq = 0;
  autoAck = true;
  socket: WebSocket | null = null;
  private wss: WebSocketServer | null = null;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];
  private receiptWaiters = new Map<string, (r: Receipt) => void>();
  port = 0;

  static async start(port = 0): Promise<FakeCoordinator> {
    const c = new FakeCoordinator();
    await c.listen(port);
    return c;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(port = this.port): Promise<void> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/ws/host" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    this.port = (wss.address() as AddressInfo).port;
    this.wss = wss;
    wss.on("connection", (ws) => {
      this.socket?.terminate();
      this.socket = ws;
      ws.on("message", (raw) => {
        const frame = HostToCoordinator.parse(JSON.parse(raw.toString()));
        switch (frame.type) {
          case "hello":
            this.hellos.push(frame);
            this.send({
              type: "welcome",
              coordinatorVersion: "test",
              ackedHostSeq: this.ackedHostSeq,
            });
            break;
          case "event":
            this.events.push({ hostSeq: frame.hostSeq, event: frame.event });
            if (this.autoAck) {
              this.ackedHostSeq = Math.max(this.ackedHostSeq, frame.hostSeq);
              this.send({ type: "ack", hostSeq: this.ackedHostSeq });
            }
            break;
          case "receipt": {
            this.receipts.push(frame.receipt);
            const w = this.receiptWaiters.get(frame.receipt.commandId);
            if (w) {
              this.receiptWaiters.delete(frame.receipt.commandId);
              w(frame.receipt);
            }
            break;
          }
          case "term":
            this.term.push({ streamId: frame.streamId, msg: frame.msg });
            break;
          default:
            break;
        }
        this.check();
      });
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
        this.check();
      });
      this.check();
    });
  }

  /** Close the server and every connection (the host starts reconnecting). */
  async close(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const c of wss.clients) c.terminate();
    this.socket = null;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  send(frame: CoordinatorToHost): void {
    this.socket?.send(JSON.stringify(frame));
  }

  sendTerm(streamId: string, msg: TermCoordinatorMsg): void {
    this.send({ type: "term", streamId, msg });
  }

  get connected(): boolean {
    return this.socket !== null && this.hellos.length > 0;
  }

  /** Send a command and wait for its receipt. */
  command<T = unknown>(
    command: HostCommand,
    opts: { commandId?: string; timeoutMs?: number } = {},
  ) {
    const commandId = opts.commandId ?? newId("cmd");
    const p = new Promise<Receipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.receiptWaiters.delete(commandId);
        reject(new Error(`no receipt for ${command.type} ${commandId}`));
      }, opts.timeoutMs ?? 30000);
      this.receiptWaiters.set(commandId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    this.send({ type: "command", commandId, command });
    return p as Promise<Receipt & { result?: T }>;
  }

  /** Send a command and return its result, throwing on an error receipt. */
  async ok<T = any>(command: HostCommand): Promise<T> {
    const r = await this.command<T>(command);
    if (!r.ok) throw new Error(`${command.type} failed: ${r.error.code}: ${r.error.message}`);
    return r.result as T;
  }

  eventsOf(type: string, sessionId?: string): HostEvent[] {
    return this.events
      .map((e) => e.event)
      .filter((e) => e.type === type && (sessionId === undefined || e.sessionId === sessionId));
  }

  /** Wait until `pred` holds (re-checked on every frame). */
  waitUntil(pred: () => boolean, timeoutMs = 30000, label = "condition"): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w = {
        pred,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async waitEvent(
    pred: (e: HostEvent) => boolean,
    timeoutMs = 30000,
    label = "event",
  ): Promise<HostEvent> {
    let found: HostEvent | undefined;
    await this.waitUntil(
      () => {
        found = this.events.map((e) => e.event).find(pred);
        return found !== undefined;
      },
      timeoutMs,
      label,
    );
    return found!;
  }

  private check(): void {
    for (const w of [...this.waiters]) {
      if (w.pred()) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve();
      }
    }
  }
}

export function tempDir(prefix = "switchyard-host-"): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export interface HostHarness {
  coord: FakeCoordinator;
  agent: HostAgentHandle;
  stateDir: string;
  pi: PiEnv | null;
  mock: MockModelServer | null;
  /** Start another agent on the same state dir (after the first was stopped or crashed). */
  restartAgent(hooks?: HostTestHooks): Promise<HostAgentHandle>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  script?: MockScript;
  /** Start real Pi + mock model (default true). */
  withPi?: boolean;
  testHooks?: HostTestHooks;
  terminalSessions?: boolean;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<HostHarness> {
  const withPi = opts.withPi !== false;
  if (withPi) requirePi();
  const coord = await FakeCoordinator.start();
  const state = tempDir();
  const mock = withPi ? await startMockModel(opts.script ?? []) : null;
  const pi = mock ? makePiEnv({ mockUrl: mock.url }) : null;
  const config = {
    coordinatorUrl: coord.url,
    hostId: "hst_test",
    credential: "secret",
    name: "test host",
  };
  const agents: HostAgentHandle[] = [];
  const launch = async (hooks?: HostTestHooks) => {
    const agent = await runHostAgent({
      config,
      stateDir: state.path,
      piBin: piBin(),
      env: pi?.env ?? { PI_CODING_AGENT_DIR: join(state.path, "no-pi") },
      extraExtensions: [fixtureExtensionPath()],
      ownerAdapterDir: join(state.path, "owner-adapters"),
      handleSignals: false,
      backoffMs: [50, 100, 200],
      logger: silentLogger(),
      testHooks: hooks,
      terminalSessions: opts.terminalSessions ?? false,
    });
    agents.push(agent);
    return agent;
  };
  const agent = await launch(opts.testHooks);
  await coord.waitUntil(() => coord.connected, 10000, "host hello");
  return {
    coord,
    agent,
    stateDir: state.path,
    pi,
    mock,
    restartAgent: launch,
    async dispose() {
      for (const a of agents) await a.stop({ terminals: "stop" }).catch(() => {});
      await coord.close();
      await mock?.close();
      pi?.cleanup();
      state.cleanup();
    },
  };
}

export function startCommand(
  sessionId: string,
  cwd: string,
  extra: Partial<Extract<HostCommand, { type: "session.start" }>> = {},
): HostCommand {
  return {
    type: "session.start",
    sessionId,
    title: "Test session",
    workspacePath: cwd,
    projectId: null,
    profile: mockProfile,
    nativeHandle: null,
    initialPrompt: null,
    dispatchKey: null,
    controlRevision: 1,
    controlMode: "human",
    origin: "human",
    readOnly: false,
    ...extra,
  };
}

/** Poll `pred` until it holds. */
export async function waitFor(pred: () => boolean, timeoutMs = 30000, label = "condition") {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { WebSocket };
