import { type ClientToServer, reconnectDelay, type ServerToClient } from "@switchyard/protocol";
import WebSocket from "ws";
import { applyEvent, applyReplay, applySnapshot, Store, setConnection } from "./store.js";

/** An error response from the coordinator REST API (`{error: {code, message, details}}`). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  coordinatorUrl: string;
  /** Device credential (or the local admin token), sent as `Authorization: Bearer`. */
  credential: string | null;
  fetch?: FetchLike;
}

/** Minimal JSON REST client for the coordinator (used by the CLI). */
export class ApiClient {
  readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly doFetch: FetchLike;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.coordinatorUrl.replace(/\/+$/, "");
    this.credential = opts.credential;
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiRequestError(
        0,
        "host_unreachable",
        `Cannot reach coordinator ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
        ?.error;
      throw new ApiRequestError(
        res.status,
        e?.code ?? (res.status === 401 ? "unauthorized" : "internal"),
        e?.message ?? `HTTP ${res.status} for ${method} ${path}`,
        e?.details,
      );
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

export function wsUrlFor(coordinatorUrl: string): string {
  const u = new URL(coordinatorUrl.replace(/\/+$/, ""));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws/client`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export interface ClientOptions extends ApiClientOptions {
  /** WebSocket constructor (tests inject a fake). */
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  pingIntervalMs?: number;
}

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * The herdr mirror's connection to a coordinator: `/ws/client` live sync of entities into an
 * in-memory `Store`, reconnect with backoff and `force_logout` handling; `api` for REST calls.
 */
export class SwitchyardClient {
  readonly api: ApiClient;
  readonly store = new Store();
  private readonly opts: ClientOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private logoutListeners = new Set<(reason: string) => void>();
  private liveListeners = new Set<() => void>();

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.api = new ApiClient(opts);
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => undefined);
    try {
      ws?.close(1000, "client closed");
    } catch {
      // not open yet
    }
  }

  onLogout(fn: (reason: string) => void): () => void {
    this.logoutListeners.add(fn);
    return () => this.logoutListeners.delete(fn);
  }

  /** Called each time the connection becomes live (after replay or snapshot). */
  onLive(fn: () => void): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  send(msg: ClientToServer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private open(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const headers: Record<string, string> = {};
    if (this.opts.credential) headers.authorization = `Bearer ${this.opts.credential}`;
    let ws: WebSocket;
    try {
      ws = new Impl(wsUrlFor(this.opts.coordinatorUrl), { headers });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      const cursor = this.store.getState().seq;
      ws.send(JSON.stringify({ type: "hello", cursor } satisfies ClientToServer));
    });
    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(raw.toString()) as ServerToClient;
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.on("unexpected-response", (_req, res) => {
      if (this.ws !== ws) return;
      const code = res.statusCode ?? 0;
      res.resume();
      if (code === 401 || code === 403) {
        this.logout(code === 401 ? "This device's credential was rejected" : "Forbidden");
        return;
      }
      // Abort the handshake: with a listener attached, ws leaves the socket open otherwise.
      this.ws = null;
      ws.terminate();
      this.scheduleReconnect();
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (code === 4401 || code === 4403) {
        this.logout(reason.toString() || "unauthorized");
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // close follows and schedules the reconnect.
    });
  }

  private handle(msg: ServerToClient): void {
    switch (msg.type) {
      case "snapshot":
        this.store.update((s) => applySnapshot(s, msg.seq, msg.state));
        this.becomeLive();
        break;
      case "replay":
        this.store.update((s) => applyReplay(s, msg.seq, msg.events));
        this.becomeLive();
        break;
      case "event":
        this.store.update((s) => applyEvent(s, msg.event));
        break;
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      case "force_logout":
        this.logout(msg.reason);
        break;
    }
  }

  private becomeLive(): void {
    this.attempts = 0;
    this.store.update((s) => setConnection(s, { state: "live", attempts: 0, reason: null }));
    this.startPing();
    for (const fn of this.liveListeners) fn();
  }

  private logout(reason: string): void {
    this.close();
    this.store.update((s) => setConnection(s, { state: "logged_out", reason }));
    for (const fn of this.logoutListeners) fn(reason);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: "ping" })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, this.opts.pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempts++;
    this.store.update((s) =>
      setConnection(s, {
        state: s.synced ? "reconnecting" : "connecting",
        attempts: this.attempts,
      }),
    );
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.open();
      },
      reconnectDelay(this.attempts - 1, undefined, this.opts.random),
    );
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
  }
}
