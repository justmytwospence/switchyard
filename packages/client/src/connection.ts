import {
  CLIENT_CAPABILITIES,
  type ClientToServer,
  type EventEnvelope,
  reconnectDelay,
  type ServerToClient,
  type SyncState,
} from "@switchyard/protocol";
import WebSocket from "ws";
import { ApiClient, type ApiClientOptions } from "./api.js";
import { applyEvent, applyReplay, applySnapshot, Store, setConnection } from "./store.js";

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
  /** Event-only resume: do not use this connection's unseeded entity store for waits. */
  initialCursor?: number;
  projectionId?: string | null;
}

export type EventNotice =
  | { type: "event"; event: EventEnvelope; projectionId: string | null }
  | { type: "reset"; seq: number; state: SyncState; projectionId: string | null };

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * The herdr mirror's connection to a coordinator: `/ws/client` live sync of entities into an
 * in-memory `Store`, reconnect with backoff and `force_logout` handling; `api` for REST calls.
 */
export class ClientConnection {
  readonly api: ApiClient;
  readonly store = new Store();
  private readonly opts: ClientOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private revoked = false;
  private attempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private logoutListeners = new Set<(reason: string) => void>();
  private liveListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private noticeListeners = new Set<(notice: EventNotice) => void>();
  private cursor: number | null;
  projectionId: string | null;
  capabilities: string[] = [];

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.api = new ApiClient(opts);
    if (
      opts.initialCursor !== undefined &&
      (!Number.isSafeInteger(opts.initialCursor) || opts.initialCursor < 0)
    )
      throw new RangeError("Invalid cursor");
    this.cursor = opts.initialCursor ?? null;
    this.projectionId = opts.projectionId ?? null;
  }

  connect(): void {
    if (!this.stopped || this.revoked) return;
    this.stopped = false;
    this.open();
  }

  close(): void {
    if (this.stopped && !this.ws) return;
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => undefined);
    try {
      if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws?.close(1000, "client closed");
    } catch {
      ws?.terminate();
    }
    for (const fn of this.closeListeners) fn();
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

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  onNotice(fn: (notice: EventNotice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
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
      ws.send(
        JSON.stringify({
          type: "hello",
          cursor: this.cursor,
          capabilities: [...CLIENT_CAPABILITIES],
          projectionId: this.projectionId,
        } satisfies ClientToServer),
      );
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
        this.acknowledge(msg);
        this.cursor = msg.seq;
        this.store.update((s) => applySnapshot(s, msg.seq, msg.state), true);
        this.emitNotice({
          type: "reset",
          seq: msg.seq,
          state: msg.state,
          projectionId: this.projectionId,
        });
        this.becomeLive();
        break;
      case "replay":
        this.acknowledge(msg);
        for (const event of [...msg.events].sort((a, b) => a.seq - b.seq)) {
          if (this.cursor !== null && event.seq <= this.cursor) continue;
          this.cursor = event.seq;
          this.store.update((s) => applyEvent(s, event));
          this.emitNotice({ type: "event", event, projectionId: this.projectionId });
        }
        this.cursor = Math.max(this.cursor ?? 0, msg.seq);
        this.store.update((s) => applyReplay(s, msg.seq, []));
        this.becomeLive();
        break;
      case "event":
        if (this.cursor !== null && msg.event.seq <= this.cursor) break;
        this.cursor = msg.event.seq;
        this.store.update((s) => applyEvent(s, msg.event));
        this.emitNotice({ type: "event", event: msg.event, projectionId: this.projectionId });
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

  private acknowledge(msg: Extract<ServerToClient, { type: "snapshot" | "replay" }>): void {
    this.capabilities = (msg.capabilities ?? []).filter((name) =>
      (CLIENT_CAPABILITIES as readonly string[]).includes(name),
    );
    this.projectionId = msg.projectionId ?? null;
  }

  private emitNotice(notice: EventNotice): void {
    for (const fn of [...this.noticeListeners]) fn(notice);
  }

  private becomeLive(): void {
    if (this.stopped) return;
    this.attempts = 0;
    this.store.update((s) => setConnection(s, { state: "live", attempts: 0, reason: null }));
    this.startPing();
    for (const fn of this.liveListeners) fn();
  }

  private logout(reason: string): void {
    if (this.revoked) return;
    this.revoked = true;
    this.store.update((s) => setConnection(s, { state: "logged_out", reason }));
    for (const fn of [...this.logoutListeners]) fn(reason);
    this.close();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: "ping" })) return;
      if (this.pongTimer) return;
      const socket = this.ws;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.ws === socket) socket?.terminate();
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
