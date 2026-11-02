import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CoordinatorToHost,
  HostCommand,
  HostEvent,
  Receipt,
  ServerToClient,
} from "@switchyard/protocol";
import { WebSocket } from "ws";
import {
  type Coordinator,
  type CreateCoordinatorOptions,
  createCoordinator,
  createLogger,
} from "../src/index.js";

export interface TestCoordinator {
  c: Coordinator;
  dir: string;
  clock: { now: number; advance(ms: number): void };
  api: (method: string, path: string, opts?: ApiOpts) => Promise<ApiResult>;
  admin: (method: string, path: string, body?: unknown) => Promise<ApiResult>;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface ApiOpts {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

export function tempDir(prefix = "sy-coord-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function startCoordinator(
  over: Partial<CreateCoordinatorOptions> & { dir?: string } = {},
): Promise<TestCoordinator> {
  const dir = over.dir ?? tempDir();
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      this.now += ms;
    },
  };
  const c = createCoordinator({
    dataDir: dir,
    listen: { host: "127.0.0.1", port: 0 },
    logger: createLogger({ level: process.env.SY_LOG ?? "silent" }),
    bootstrap: false,
    clock: () => new Date(clock.now),
    ...over,
  });
  await c.start();
  const api = async (method: string, path: string, opts: ApiOpts = {}): Promise<ApiResult> => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${c.localUrl}${path}`, {
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
    return { status: res.status, body, headers: res.headers };
  };
  let stopped = false;
  return {
    c,
    dir,
    clock,
    api,
    admin: (method, path, body) => api(method, path, { token: c.adminToken, body }),
    async stop() {
      if (stopped) return;
      stopped = true;
      await c.stop();
    },
    async cleanup() {
      if (!stopped) {
        stopped = true;
        await c.stop();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function enrollHost(
  t: TestCoordinator,
  name = "test-host",
): Promise<{ hostId: string; credential: string }> {
  const e = await t.admin("POST", "/api/hosts/enrollments");
  if (e.status !== 201) throw new Error(`enrollment failed ${JSON.stringify(e.body)}`);
  const r = await t.api("POST", "/api/hosts/enroll", {
    body: { token: e.body.token, name, platform: "darwin" },
  });
  if (r.status !== 201) throw new Error(`host enroll failed ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function enrollDevice(
  t: TestCoordinator,
  kind: "browser" | "pwa" | "terminal" | "cli" = "terminal",
  name = "test-device",
): Promise<{ deviceId: string; credential: string; cookie: string | null }> {
  const e = await t.admin("POST", "/api/enrollments", { kind: "device" });
  const r = await t.api("POST", "/api/enroll", { body: { token: e.body.token, name, kind } });
  if (r.status !== 201) throw new Error(`device enroll failed ${JSON.stringify(r.body)}`);
  const setCookie = r.headers.get("set-cookie");
  return { ...r.body, cookie: setCookie ? setCookie.split(";")[0]! : null };
}

/** Collects JSON messages from a socket and waits for matching ones. */
class Inbox<T> {
  messages: T[] = [];
  private waiters: { pred: (m: T) => boolean; resolve: (m: T) => void }[] = [];
  push(m: T) {
    this.messages.push(m);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  }
  waitFor(pred: (m: T) => boolean, timeoutMs = 5000, fromIndex = 0): Promise<T> {
    const found = this.messages.slice(fromIndex).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

export type CommandHandler = (
  cmd: HostCommand,
  commandId: string,
) => unknown | Promise<unknown> | { __error: { code: string; message: string } } | typeof NO_REPLY;

export const NO_REPLY = Symbol("no-reply");

/** A raw-ws fake host speaking the host wire protocol. */
export class FakeHost {
  inbox = new Inbox<CoordinatorToHost>();
  commands: { commandId: string; command: HostCommand }[] = [];
  handler: CommandHandler = () => null;
  ws!: WebSocket;
  private seq = 0;
  closed = false;

  constructor(
    private readonly url: string,
    readonly hostId: string,
    private readonly credential: string,
  ) {}

  static async connect(
    t: TestCoordinator,
    creds: { hostId: string; credential: string },
    handler?: CommandHandler,
  ): Promise<FakeHost> {
    const h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    if (handler) h.handler = handler;
    await h.open();
    return h;
  }

  /** Open and send hello; resolves with the welcome (or reject) frame. */
  open(overrides: Record<string, unknown> = {}): Promise<CoordinatorToHost> {
    this.inbox = new Inbox();
    this.closed = false;
    this.ws = new WebSocket(`${this.url}/ws/host`);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as CoordinatorToHost;
      this.inbox.push(msg);
      if (msg.type === "command") void this.onCommand(msg.commandId, msg.command);
    });
    this.ws.on("close", () => {
      this.closed = true;
    });
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        this.ws.send(
          JSON.stringify({
            type: "hello",
            hostId: this.hostId,
            credential: this.credential,
            name: "fake-host",
            agentVersion: "0.0.0-test",
            piVersion: "1.4.0",
            piCompatible: true,
            platform: "darwin",
            capabilities: null,
            protocolVersion: 1,
            ...overrides,
          }),
        );
        this.inbox
          .waitFor((m) => m.type === "welcome" || m.type === "reject")
          .then(resolve, reject);
      });
      this.ws.once("error", reject);
    });
  }

  private async onCommand(commandId: string, command: HostCommand) {
    this.commands.push({ commandId, command });
    let receipt: Receipt;
    try {
      const r = await this.handler(command, commandId);
      if (r === NO_REPLY) return;
      if (r && typeof r === "object" && "__error" in (r as object)) {
        receipt = { commandId, ok: false, error: (r as any).__error };
      } else {
        receipt = { commandId, ok: true, result: r ?? null };
      }
    } catch (err) {
      receipt = {
        commandId,
        ok: false,
        error: { code: (err as any).code ?? "internal", message: String(err) },
      };
    }
    this.sendRaw({ type: "receipt", receipt });
  }

  sendRaw(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Send an event with the next hostSeq (or an explicit one) and wait for its ack. */
  async event(
    type: HostEvent["type"],
    data: unknown,
    opts: { hostSeq?: number; eventId?: string; sessionId?: string } = {},
  ): Promise<number> {
    const hostSeq = opts.hostSeq ?? ++this.seq;
    if (opts.hostSeq !== undefined) this.seq = Math.max(this.seq, opts.hostSeq);
    const event: HostEvent = {
      eventId: opts.eventId ?? `hev_${hostSeq}_${Math.random().toString(36).slice(2)}`,
      type,
      at: new Date().toISOString(),
      data,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };
    const from = this.inbox.messages.length;
    this.sendRaw({ type: "event", hostSeq, event });
    await this.inbox.waitFor((m) => m.type === "ack" && m.hostSeq >= hostSeq, 5000, from);
    return hostSeq;
  }

  waitForCommand(type: HostCommand["type"], timeoutMs = 5000) {
    return this.inbox.waitFor(
      (m) => m.type === "command" && m.command.type === type,
      timeoutMs,
    ) as Promise<Extract<CoordinatorToHost, { type: "command" }>>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

/** A raw-ws client on `/ws/client`. */
export class FakeClient {
  inbox = new Inbox<ServerToClient>();
  ws!: WebSocket;
  closeCode: number | null = null;

  static async connect(
    t: TestCoordinator,
    auth: { token?: string; cookie?: string; origin?: string },
  ): Promise<FakeClient> {
    const c = new FakeClient();
    const headers: Record<string, string> = {};
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    if (auth.cookie) headers.cookie = auth.cookie;
    if (auth.origin) headers.origin = auth.origin;
    c.ws = new WebSocket(`${t.c.localUrl.replace("http", "ws")}/ws/client`, { headers });
    c.ws.on("message", (raw) => c.inbox.push(JSON.parse(raw.toString())));
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

  async hello(cursor: number | null): Promise<ServerToClient> {
    const from = this.inbox.messages.length;
    this.send({ type: "hello", cursor });
    return this.inbox.waitFor((m) => m.type === "replay" || m.type === "snapshot", 5000, from);
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function until(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleep(stepMs);
  }
}

/** A minimal valid Session payload as a host would send it. */
export function hostSession(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: "Host session",
    cwd: "/tmp/repo",
    runtime: "idle",
    runtimeDetail: null,
    nativeHandle: { sessionId: "native-1", sessionFile: "/tmp/native-1.jsonl" },
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    lastActivityAt: new Date().toISOString(),
    ...over,
  };
}
