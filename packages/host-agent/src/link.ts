import { EventEmitter } from "node:events";
import {
  CoordinatorToHost,
  type HostCommand,
  type HostEvent,
  type HostEventType,
  type HostToCoordinator,
  newId,
  type Receipt,
  reconnectDelay,
  type StreamDelta,
  type TermCoordinatorMsg,
  type TermServerToViewer,
} from "@switchyard/protocol";
import WebSocket from "ws";
import type { HostDb } from "./db/index.js";
import type { Logger } from "./logger.js";

/** Acked outbox rows are kept this long for diagnostics. */
export const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACKED_META = "outbox.ackedHostSeq";

export type HelloInfo = Omit<
  Extract<HostToCoordinator, { type: "hello" }>,
  "type" | "hostId" | "credential"
>;

export interface CoordinatorLinkOptions {
  db: HostDb;
  coordinatorUrl: string;
  hostId: string;
  credential: string;
  /** Hello payload, evaluated on every connect. */
  hello: () => HelloInfo;
  onCommand: (commandId: string, command: unknown) => void;
  /** Terminal relay frames from the coordinator. */
  onTerm?: (streamId: string, msg: TermCoordinatorMsg) => void;
  log: Logger;
  /** Reconnect delays; the last value repeats (default RECONNECT_BACKOFF_MS). */
  backoffMs?: readonly number[];
  /** Interval for the WebSocket keepalive ping (default 20 s). */
  pingIntervalMs?: number;
}

export interface OutboxRow {
  hostSeq: number;
  eventId: string;
  event: HostEvent;
  createdAt: string;
}

/** What callers pass to `emit()`; `eventId` and `at` are filled in. */
export type HostEventInput = {
  type: HostEventType;
  data: unknown;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  at?: string;
};

export interface CoordinatorLinkEvents {
  connected: [];
  welcome: [{ coordinatorVersion: string; ackedHostSeq: number }];
  disconnected: [{ code: number; reason: string }];
  rejected: [{ code: string; message: string }];
}

/** Convert `http(s)://host/x` to `ws(s)://host/x/ws/host`. */
export function hostSocketUrl(coordinatorUrl: string): string {
  const u = new URL(coordinatorUrl);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws/host`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * The host's outbound link to the coordinator. Durable events go through the SQLite outbox:
 * `emit()` inserts a row (inside the caller's transaction when there is one) and the link sends
 * rows in `hostSeq` order after commit. After `welcome {ackedHostSeq}` every row above the
 * coordinator's ack is replayed in order, so each event arrives exactly once per ack cycle
 * (the coordinator also dedupes by `eventId`). Streams and receipts are sent only while
 * connected; the coordinator re-sends unanswered commands, and receipts are deduped by id.
 */
export class CoordinatorLink {
  /** Link lifecycle notifications (`connected`, `welcome`, `disconnected`, `rejected`). */
  readonly events = new EventEmitter<CoordinatorLinkEvents>();
  private readonly opts: CoordinatorLinkOptions;
  private readonly db: HostDb;
  private ws: WebSocket | null = null;
  /** True between `welcome` and close: events may be sent. */
  private ready = false;
  /** Highest hostSeq sent on the current connection. */
  private sentUpTo = 0;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = Date.now();
  private flushScheduled = false;

  constructor(opts: CoordinatorLinkOptions) {
    this.opts = opts;
    this.db = opts.db;
  }

  get connected(): boolean {
    return this.ready;
  }

  get url(): string {
    return hostSocketUrl(this.opts.coordinatorUrl);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Close the socket and stop reconnecting. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        ws.close(1000, "host agent stopping");
      } catch {
        ws.terminate();
      }
    });
  }

  /** Drop the current connection (it reconnects after the backoff). For tests and diagnostics. */
  dropConnection(): void {
    this.ws?.terminate();
  }

  // ---- outbox ----

  /**
   * Persist a durable event in the outbox and send it once committed. Call inside the same
   * `db.tx()` as the state change that caused it.
   */
  emit(input: HostEventInput): OutboxRow {
    const event: HostEvent = {
      eventId: newId("evt"),
      type: input.type,
      at: input.at ?? new Date().toISOString(),
      data: input.data,
      hostId: this.opts.hostId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    const createdAt = new Date().toISOString();
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO outbox (event_id, json, created_at) VALUES (?, ?, ?)",
      [event.eventId, JSON.stringify(event), createdAt],
    );
    this.db.afterCommit(() => this.scheduleFlush());
    return { hostSeq: lastInsertRowid, eventId: event.eventId, event, createdAt };
  }

  /** Outbox rows above `afterSeq`, in order. */
  pending(afterSeq = this.ackedHostSeq()): OutboxRow[] {
    return this.db
      .all<{ host_seq: number; event_id: string; json: string; created_at: string }>(
        "SELECT host_seq, event_id, json, created_at FROM outbox WHERE host_seq > ? ORDER BY host_seq",
        [afterSeq],
      )
      .map((r) => ({
        hostSeq: r.host_seq,
        eventId: r.event_id,
        event: JSON.parse(r.json) as HostEvent,
        createdAt: r.created_at,
      }));
  }

  ackedHostSeq(): number {
    return Number(this.db.getMeta(ACKED_META) ?? 0);
  }

  lastHostSeq(): number {
    const r = this.db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'");
    return r?.seq ?? 0;
  }

  // ---- ephemeral frames ----

  sendStream(delta: StreamDelta): void {
    if (this.ready) this.send({ type: "stream", delta });
  }

  /** Send a terminal relay frame now if connected. */
  sendTerm(streamId: string, msg: TermServerToViewer): boolean {
    return this.ready ? this.send({ type: "term", streamId, msg }) : false;
  }

  /** Send a receipt now if connected (stored receipts are resent on a duplicate command). */
  sendReceipt(receipt: Receipt): boolean {
    if (!this.ready) return false;
    return this.send({ type: "receipt", receipt });
  }

  // ---- internals ----

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15000, perMessageDeflate: false });
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message }, "cannot open coordinator link");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.lastPong = Date.now();
      this.send({
        type: "hello",
        hostId: this.opts.hostId,
        credential: this.opts.credential,
        ...this.opts.hello(),
      });
      this.startPing(ws);
      this.events.emit("connected");
    });
    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      this.lastPong = Date.now();
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch (err) {
        this.opts.log.warn({ err: (err as Error).message }, "invalid coordinator frame");
        return;
      }
      const parsed = CoordinatorToHost.safeParse(json);
      if (parsed.success) {
        this.onFrame(parsed.data);
        return;
      }
      const loose = json as { type?: unknown; commandId?: unknown; command?: unknown } | null;
      if (loose?.type === "command" && typeof loose.commandId === "string") {
        // Let the router answer an invalid command with an invalid_request receipt.
        this.opts.onCommand(loose.commandId, loose.command);
        return;
      }
      this.opts.log.warn({ err: parsed.error.message }, "invalid coordinator frame");
    });
    ws.on("pong", () => {
      this.lastPong = Date.now();
    });
    ws.on("error", (err) => {
      this.opts.log.debug({ err: err.message }, "coordinator link error");
    });
    ws.on("close", (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasReady = this.ready;
      this.ready = false;
      this.stopPing();
      const reason = reasonBuf.toString();
      if (wasReady) this.opts.log.info({ code, reason }, "coordinator link closed");
      this.events.emit("disconnected", { code, reason });
      this.scheduleReconnect();
    });
  }

  private onFrame(frame: CoordinatorToHost): void {
    switch (frame.type) {
      case "welcome": {
        this.attempt = 0;
        const acked = frame.ackedHostSeq;
        this.db.tx(() => {
          this.recordAck(acked);
          // The coordinator saw more than we ever wrote (our DB was reset): never reuse those seqs.
          if (acked > this.lastHostSeq()) {
            this.db.run("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('outbox', ?)", [
              acked,
            ]);
          }
        });
        this.sentUpTo = acked;
        this.ready = true;
        this.opts.log.info({ ackedHostSeq: acked }, "coordinator link ready");
        this.events.emit("welcome", {
          coordinatorVersion: frame.coordinatorVersion,
          ackedHostSeq: acked,
        });
        this.flush();
        return;
      }
      case "ack":
        this.db.tx(() => this.recordAck(frame.hostSeq));
        return;
      case "command":
        try {
          this.opts.onCommand(frame.commandId, frame.command as HostCommand);
        } catch (err) {
          this.opts.log.error({ err: (err as Error).message }, "command dispatch failed");
        }
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "term":
        try {
          this.opts.onTerm?.(frame.streamId, frame.msg);
        } catch (err) {
          this.opts.log.warn({ err: (err as Error).message }, "terminal frame failed");
        }
        return;
      case "reject":
        this.opts.log.warn({ error: frame.error }, "coordinator rejected the host link");
        this.events.emit("rejected", { code: frame.error.code, message: frame.error.message });
        return;
    }
  }

  /** Record a cumulative ack and prune acked rows older than the retention window. */
  private recordAck(hostSeq: number): void {
    const prev = this.ackedHostSeq();
    if (hostSeq > prev) this.db.setMeta(ACKED_META, String(hostSeq));
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString();
    this.db.run("DELETE FROM outbox WHERE host_seq <= ? AND created_at < ?", [
      Math.max(prev, hostSeq),
      cutoff,
    ]);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /** Send every committed outbox row above `sentUpTo`, in order. */
  private flush(): void {
    if (!this.ready) return;
    for (const row of this.pending(this.sentUpTo)) {
      if (!this.send({ type: "event", hostSeq: row.hostSeq, event: row.event })) return;
      this.sentUpTo = row.hostSeq;
    }
  }

  private send(frame: HostToCoordinator): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.opts.log.debug({ err: (err as Error).message }, "send failed");
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = reconnectDelay(this.attempt, this.opts.backoffMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Not unref'd: while the coordinator is down, this timer is what keeps a host agent alive.
  }

  private startPing(ws: WebSocket): void {
    this.stopPing();
    const interval = this.opts.pingIntervalMs ?? 20000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > interval * 2.5) {
        this.opts.log.warn("coordinator link silent; reconnecting");
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch {
        // closing
      }
    }, interval);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
