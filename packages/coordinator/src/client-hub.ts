import {
  ClientToServer,
  type EventEnvelope,
  type ServerToClient,
  type StreamDelta,
} from "@switchyard/protocol";
import type { Logger } from "pino";
import type { WebSocket } from "ws";
import type { AuthedDevice } from "./auth.js";
import type { EventHub } from "./event-hub.js";
import type { Store } from "./store.js";

export interface ClientHubOptions {
  foregroundLeaseMs: number;
  /** Cursors further behind than this get a snapshot instead of a replay. */
  maxReplay?: number;
  pingIntervalMs?: number;
}

interface ClientConn {
  socket: WebSocket;
  deviceId: string;
  synced: boolean;
  alive: boolean;
}

const WsOpen = 1;
const MAX_BUFFERED = 8 * 1024 * 1024;

/**
 * `/ws/client`: cursor replay or snapshot on hello, then live durable events and stream deltas.
 * Presence messages are stored with an expiring foreground lease.
 */
export class ClientHub {
  private conns = new Set<ClientConn>();
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly onEvent = (e: EventEnvelope) => this.broadcast({ type: "event", event: e });
  private readonly onStream = (delta: StreamDelta) => this.broadcast({ type: "stream", delta });
  private readonly onRevoked = ({ deviceId }: { deviceId: string }) =>
    this.forceLogout(deviceId, "This device was revoked");

  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
    private readonly log: Logger,
    private readonly opts: ClientHubOptions,
  ) {}

  start(): void {
    this.hub.on("event", this.onEvent);
    this.hub.on("stream", this.onStream);
    this.hub.on("device.revoked", this.onRevoked);
    this.pingTimer = setInterval(() => this.heartbeat(), this.opts.pingIntervalMs ?? 25_000);
    this.pingTimer.unref();
  }

  stop(): void {
    this.hub.off("event", this.onEvent);
    this.hub.off("stream", this.onStream);
    this.hub.off("device.revoked", this.onRevoked);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.conns) c.socket.close(1001, "coordinator stopping");
    this.conns.clear();
  }

  connectedDeviceIds(): string[] {
    return [...new Set([...this.conns].map((c) => c.deviceId))];
  }

  handleSocket(socket: WebSocket, device: AuthedDevice): void {
    const conn: ClientConn = { socket, deviceId: device.id, synced: false, alive: true };
    this.conns.add(conn);
    socket.on("message", (raw) => {
      let msg: ClientToServer;
      try {
        msg = ClientToServer.parse(JSON.parse(raw.toString()));
      } catch (err) {
        this.log.debug({ err }, "invalid client frame");
        return;
      }
      try {
        this.onMessage(conn, msg);
      } catch (err) {
        this.log.error({ err }, "client frame handling failed");
      }
    });
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("close", () => this.conns.delete(conn));
    socket.on("error", (err) => this.log.debug({ err }, "client socket error"));
  }

  private onMessage(conn: ClientConn, msg: ClientToServer): void {
    switch (msg.type) {
      case "hello":
        this.sync(conn, msg.cursor);
        return;
      case "ping":
        this.sendTo(conn, { type: "pong" });
        return;
      case "presence": {
        const now = this.store.now();
        const p = msg.presence;
        this.store.upsertPresence({
          deviceId: conn.deviceId,
          foregroundUntil: p.foreground
            ? new Date(now.getTime() + this.opts.foregroundLeaseMs).toISOString()
            : null,
          interactedAt: p.interactedAt,
          viewingSessionId: p.viewing?.sessionId ?? null,
          updatedAt: now.toISOString(),
        });
        this.hub.emit("presence.changed", { deviceId: conn.deviceId });
        return;
      }
    }
  }

  /**
   * Replay when every event after `cursor` is still retained; otherwise send a snapshot. Runs
   * synchronously so no event can be published between the query and the subscription.
   */
  private sync(conn: ClientConn, cursor: number | null): void {
    const current = this.store.currentSeq();
    const maxReplay = this.opts.maxReplay ?? 5000;
    const canReplay =
      cursor !== null &&
      cursor >= this.store.minRetainedSeq() &&
      cursor <= current &&
      current - cursor <= maxReplay;
    if (canReplay) {
      const events = this.store.eventsAfter(cursor, maxReplay + 1);
      this.sendTo(conn, { type: "replay", seq: current, events });
    } else {
      this.sendTo(conn, { type: "snapshot", seq: current, state: this.store.syncState() });
    }
    conn.synced = true;
  }

  private sendTo(conn: ClientConn, msg: ServerToClient): void {
    const s = conn.socket;
    if (s.readyState !== WsOpen) return;
    if (s.bufferedAmount > MAX_BUFFERED) {
      this.log.warn({ deviceId: conn.deviceId }, "client too slow; closing to force resync");
      s.close(1013, "too slow; reconnect with cursor");
      return;
    }
    s.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerToClient): void {
    const text = JSON.stringify(msg);
    for (const c of this.conns) {
      if (!c.synced || c.socket.readyState !== WsOpen) continue;
      if (c.socket.bufferedAmount > MAX_BUFFERED) {
        c.socket.close(1013, "too slow; reconnect with cursor");
        continue;
      }
      c.socket.send(text);
    }
  }

  /** Send `force_logout` to every socket of a device and close them. */
  forceLogout(deviceId: string, reason: string): void {
    for (const c of [...this.conns]) {
      if (c.deviceId !== deviceId) continue;
      if (c.socket.readyState === WsOpen) {
        c.socket.send(JSON.stringify({ type: "force_logout", reason } satisfies ServerToClient));
      }
      c.socket.close(4401, reason);
      this.conns.delete(c);
    }
  }

  private heartbeat(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.socket.terminate();
        this.conns.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        // closing
      }
    }
  }
}
