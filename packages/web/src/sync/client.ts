import type { ClientToServer, ServerToClient } from "@switchyard/protocol";
import { clearCache, loadCache, saveCache } from "./cache";
import { toSyncState } from "./reduce";
import { syncStore } from "./store";

/**
 * Live sync over `/ws/client`.
 *
 * - On open: `hello {cursor}` with the last applied seq (from memory or the
 *   offline cache); the server answers `replay` (events since cursor) or
 *   `snapshot` (full SyncState).
 * - Then applies `event` and `stream` frames to the store.
 * - Reconnects with exponential backoff and jitter; `offline` while the
 *   browser reports no network.
 * - Persists `{seq, state}` (throttled) so last-known data shows on reload
 *   and while reconnecting.
 */

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PERSIST_DELAY_MS = 1_500;

type Listener = () => void;

export class SyncClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private everLive = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private liveListeners = new Set<Listener>();
  private logoutListeners = new Set<(reason: string) => void>();
  private cacheLoaded: Promise<void> | null = null;

  constructor(private readonly url: string = defaultWsUrl()) {}

  /** Load the offline cache into the store and connect. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.unsubscribeStore = syncStore.subscribe((s, prev) => {
      if (s.synced && s.seq !== prev.seq) this.schedulePersist();
    });
    this.cacheLoaded ??= loadCache().then((cached) => {
      if (cached && !syncStore.getState().synced) {
        syncStore.getState().hydrateFromCache(cached.seq, cached.state, cached.savedAt);
      }
    });
    void this.cacheLoaded.then(() => this.connect());
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "client stopped");
  }

  /** Send a frame when connected. Returns false when it could not be sent. */
  send(msg: ClientToServer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get isLive(): boolean {
    return syncStore.getState().connection.state === "live";
  }

  /** Called each time the connection becomes live (after replay or snapshot). */
  onLive(fn: Listener): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  /** Called on `force_logout` (device revoked) and on auth failures. */
  onLogout(fn: (reason: string) => void): () => void {
    this.logoutListeners.add(fn);
    return () => this.logoutListeners.delete(fn);
  }

  /** Reconnect now (for example from a "Retry" button). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      syncStore.getState().setConnection({ state: "offline" });
      return;
    }
    syncStore.getState().setConnection({ state: this.everLive ? "reconnecting" : "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const cursor = syncStore.getState().seq;
      ws.send(JSON.stringify({ type: "hello", cursor } satisfies ClientToServer));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerToClient;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      // 4401/4403/1008: the coordinator rejected our credential.
      if (ev.code === 4401 || ev.code === 4403 || ev.code === 1008) {
        this.emitLogout(ev.reason || "unauthorized");
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };
  }

  private handle(msg: ServerToClient): void {
    const store = syncStore.getState();
    switch (msg.type) {
      case "snapshot":
        store.applySnapshot(msg.seq, msg.state);
        this.becomeLive();
        break;
      case "replay":
        store.applyReplay(msg.seq, msg.events);
        this.becomeLive();
        break;
      case "event":
        store.applyEvent(msg.event);
        break;
      case "stream":
        store.applyStream(msg.delta);
        break;
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        store.setConnection({ lastSyncedAt: new Date().toISOString() });
        break;
      case "force_logout":
        this.emitLogout(msg.reason);
        break;
    }
  }

  private becomeLive(): void {
    this.everLive = true;
    this.attempts = 0;
    syncStore.getState().setConnection({ state: "live", attempts: 0 });
    this.startPing();
    this.schedulePersist();
    for (const fn of this.liveListeners) fn();
  }

  private emitLogout(reason: string): void {
    this.stop();
    void clearCache();
    syncStore.getState().reset();
    for (const fn of this.logoutListeners) fn(reason);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: "ping" })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // No pong: assume a dead socket and reconnect.
        this.ws?.close(4000, "pong timeout");
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      syncStore.getState().setConnection({ state: "offline" });
      return;
    }
    this.attempts++;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempts - 1));
    const jittered = delay / 2 + Math.random() * (delay / 2);
    syncStore.getState().setConnection({
      state: this.everLive ? "reconnecting" : "connecting",
      attempts: this.attempts,
    });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, jittered);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const s = syncStore.getState();
      if (!s.synced || s.seq === null) return;
      void saveCache({ seq: s.seq, state: toSyncState(s), savedAt: new Date().toISOString() });
    }, PERSIST_DELAY_MS);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private onOnline = () => {
    this.attempts = 0;
    this.reconnectNow();
  };

  private onOffline = () => {
    syncStore.getState().setConnection({ state: "offline" });
    this.ws?.close(4000, "offline");
  };
}

export function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/client`;
}

/** The app-wide client instance. */
export const syncClient = new SyncClient(typeof location === "undefined" ? "" : defaultWsUrl());
