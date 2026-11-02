import {
  AdapterInfo,
  AttentionReason,
  type CoordinatorToHost,
  Diagnostic,
  type Host,
  HostCommand,
  type HostEvent,
  HostToCoordinator,
  Interaction,
  newId,
  Panel,
  PROTOCOL_VERSION,
  type Profile,
  type Receipt,
  Session,
  StreamDelta,
  SwitchyardError,
  TranscriptItem,
  Workspace,
} from "@switchyard/protocol";
import type { Logger } from "pino";
import type { WebSocket } from "ws";
import type { AttentionService } from "./attention.js";
import { safeEqualHex, sha256 } from "./auth.js";
import { COORDINATOR_VERSION } from "./context.js";
import type { EventHub } from "./event-hub.js";
import type { Store } from "./store.js";

export interface HostHubOptions {
  unreachableAfterMs: number;
  commandTimeoutMs: number;
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
}

interface Pending {
  hostId: string;
  frame: string;
  resolve: (r: Receipt) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  socket: WebSocket;
  alive: boolean;
}

/** Session fields the host is authoritative for; the rest belong to the coordinator. */
const HOST_SESSION_FIELDS = [
  "title",
  "subtitle",
  "cwd",
  "nativeHandle",
  "runtime",
  "runtimeDetail",
  "queue",
  "stats",
  "lastAssistantText",
  "lastActivityAt",
] as const;

const FALLBACK_PROFILE: Profile = {
  id: "prf_unknown",
  name: "Unknown",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};

const WsOpen = 1;

/**
 * The host link: authenticates `/ws/host`, projects host events into the store (deduped by
 * eventId, acked by hostSeq), forwards stream deltas, tracks connectivity and correlates
 * command receipts.
 */
export class HostHub {
  private conns = new Map<string, Conn>();
  private pending = new Map<string, Pending>();
  private unreachableTimers = new Map<string, NodeJS.Timeout>();
  private everConnected = new Set<string>();
  /** Partial workspace updates for paths the coordinator has not recorded yet. */
  private workspaceBuffer = new Map<string, Record<string, unknown>>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
    private readonly attention: AttentionService,
    private readonly log: Logger,
    private readonly opts: HostHubOptions,
  ) {}

  /** Mark every known host disconnected (coordinator start) and arm unreachable timers. */
  start(): void {
    for (const h of this.store.hosts.list("revoked_at IS NULL")) {
      if (h.connectivity === "connected") this.setConnectivity(h.id, "reconnecting");
      if (h.connectivity !== "unreachable") this.armUnreachable(h.id);
    }
    const interval = this.opts.pingIntervalMs ?? 20_000;
    this.pingTimer = setInterval(() => this.heartbeat(), interval);
    this.pingTimer.unref();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const t of this.unreachableTimers.values()) clearTimeout(t);
    this.unreachableTimers.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new SwitchyardError("host_unreachable", "Coordinator shutting down"));
    }
    this.pending.clear();
    for (const c of this.conns.values()) c.socket.close(1001, "coordinator stopping");
    this.conns.clear();
  }

  isConnected(hostId: string): boolean {
    return this.conns.get(hostId)?.socket.readyState === WsOpen;
  }

  connectedHostIds(): string[] {
    return [...this.conns.keys()].filter((id) => this.isConnected(id));
  }

  /** Close a host's link (revocation). */
  disconnect(hostId: string, reason: string): void {
    const c = this.conns.get(hostId);
    if (!c) return;
    this.sendFrame(c.socket, {
      type: "reject",
      error: { code: "forbidden", message: reason },
    });
    c.socket.close(4403, reason);
  }

  /**
   * Send a command and resolve with its receipt (ok or error). Rejects `host_unreachable` when
   * the host is not connected and `timeout` after `timeoutMs`. Commands still awaiting a receipt
   * are re-sent with the same commandId when the host reconnects.
   */
  send(
    hostId: string,
    command: HostCommand,
    opts: { timeoutMs?: number; commandId?: string } = {},
  ): Promise<Receipt> {
    const parsed = HostCommand.parse(command);
    const conn = this.conns.get(hostId);
    if (!conn || conn.socket.readyState !== WsOpen) {
      const name = this.store.hosts.get(hostId)?.name ?? hostId;
      return Promise.reject(
        new SwitchyardError("host_unreachable", `Host ${name} is not connected`, { hostId }),
      );
    }
    const commandId = opts.commandId ?? newId("cmd");
    const existing = this.pending.get(commandId);
    if (existing) {
      return new Promise((resolve, reject) => {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (r) => {
          prevResolve(r);
          resolve(r);
        };
        existing.reject = (e) => {
          prevReject(e);
          reject(e);
        };
      });
    }
    const frame = JSON.stringify({
      type: "command",
      commandId,
      command: parsed,
    } satisfies CoordinatorToHost);
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs;
    return new Promise<Receipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(
          new SwitchyardError("timeout", `Host did not answer ${parsed.type} in time`, {
            hostId,
            commandId,
          }),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(commandId, { hostId, frame, resolve, reject, timer });
      conn.socket.send(frame);
    });
  }

  /** `send` and unwrap: returns `result` or throws a SwitchyardError with the host's code. */
  async request<T = unknown>(
    hostId: string,
    command: HostCommand,
    opts: { timeoutMs?: number; commandId?: string } = {},
  ): Promise<T> {
    const r = await this.send(hostId, command, opts);
    if (r.ok) return r.result as T;
    throw new SwitchyardError(r.error.code, r.error.message, r.error.details);
  }

  // ---- socket handling -------------------------------------------------------------------

  handleSocket(socket: WebSocket): void {
    let hostId: string | null = null;
    const helloTimer = setTimeout(() => {
      if (!hostId) socket.close(4400, "hello timeout");
    }, this.opts.helloTimeoutMs ?? 10_000);
    helloTimer.unref();

    socket.on("message", (raw) => {
      let frame: HostToCoordinator;
      try {
        frame = HostToCoordinator.parse(JSON.parse(raw.toString()));
      } catch (err) {
        this.log.warn({ err, hostId }, "invalid host frame");
        if (!hostId) {
          this.reject(socket, "invalid_request", "Expected hello");
        }
        return;
      }
      if (!hostId) {
        if (frame.type !== "hello") {
          this.reject(socket, "unauthorized", "Expected hello");
          return;
        }
        clearTimeout(helloTimer);
        hostId = this.onHello(socket, frame);
        return;
      }
      if (this.conns.get(hostId)?.socket !== socket) return;
      try {
        this.onFrame(hostId, socket, frame);
      } catch (err) {
        this.log.error({ err, hostId, type: frame.type }, "host frame handling failed");
      }
    });

    socket.on("pong", () => {
      if (!hostId) return;
      const c = this.conns.get(hostId);
      if (c && c.socket === socket) c.alive = true;
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!hostId) return;
      const c = this.conns.get(hostId);
      if (!c || c.socket !== socket) return;
      this.conns.delete(hostId);
      this.onDisconnected(hostId);
    });
    socket.on("error", (err) => this.log.warn({ err, hostId }, "host socket error"));
  }

  private reject(
    socket: WebSocket,
    code: "unauthorized" | "forbidden" | "invalid_request",
    message: string,
  ) {
    this.sendFrame(socket, { type: "reject", error: { code, message } });
    socket.close(4401, message);
  }

  private sendFrame(socket: WebSocket, frame: CoordinatorToHost): void {
    if (socket.readyState === WsOpen) socket.send(JSON.stringify(frame));
  }

  private onHello(
    socket: WebSocket,
    hello: Extract<HostToCoordinator, { type: "hello" }>,
  ): string | null {
    const hash = this.store.hostCredentialHash(hello.hostId);
    if (!hash || !safeEqualHex(hash, sha256(hello.credential))) {
      this.reject(socket, "unauthorized", "Unknown host credential");
      return null;
    }
    const host = this.store.hosts.get(hello.hostId);
    if (!host || host.revokedAt) {
      this.reject(socket, "forbidden", "This host was revoked");
      return null;
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.reject(
        socket,
        "invalid_request",
        `Protocol ${hello.protocolVersion} is not supported (coordinator speaks ${PROTOCOL_VERSION})`,
      );
      return null;
    }
    const hostId = hello.hostId;
    const old = this.conns.get(hostId);
    this.conns.set(hostId, { socket, alive: true });
    if (old && old.socket !== socket) old.socket.close(4000, "replaced by a newer connection");
    const t = this.unreachableTimers.get(hostId);
    if (t) clearTimeout(t);
    this.unreachableTimers.delete(hostId);

    this.store.tx(() => {
      const updated: Host = {
        ...host,
        name: hello.name,
        platform: hello.platform,
        agentVersion: hello.agentVersion,
        piVersion: hello.piVersion,
        piCompatible: hello.piCompatible,
        capabilities: hello.capabilities,
        connectivity: "connected",
        lastSeenAt: this.store.nowIso(),
      };
      this.store.putHost(updated);
      this.syncSessionConnectivity(hostId, "connected");
      for (const s of this.store.sessions.list("host_id = ?", [hostId])) {
        this.attention.resolve({ sessionId: s.id, reason: "host_unreachable" });
      }
    });

    this.sendFrame(socket, {
      type: "welcome",
      coordinatorVersion: COORDINATOR_VERSION,
      ackedHostSeq: this.store.ackedHostSeq(hostId),
    });
    for (const p of this.pending.values()) {
      if (p.hostId === hostId) socket.send(p.frame);
    }
    const reconnect = this.everConnected.has(hostId);
    this.everConnected.add(hostId);
    this.log.info({ hostId, name: hello.name, reconnect }, "host connected");
    this.hub.emit("host.connected", { hostId, reconnect });
    return hostId;
  }

  private onFrame(hostId: string, socket: WebSocket, frame: HostToCoordinator): void {
    switch (frame.type) {
      case "hello":
        return;
      case "event": {
        this.applyHostEvent(hostId, frame.hostSeq, frame.event);
        this.sendFrame(socket, { type: "ack", hostSeq: this.store.ackedHostSeq(hostId) });
        return;
      }
      case "stream": {
        const d = StreamDelta.safeParse(frame.delta);
        if (d.success) this.hub.emit("stream", d.data);
        return;
      }
      case "receipt": {
        const p = this.pending.get(frame.receipt.commandId);
        if (!p || p.hostId !== hostId) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.receipt.commandId);
        p.resolve(frame.receipt);
        return;
      }
      case "pong":
        return;
    }
  }

  private heartbeat(): void {
    for (const [hostId, c] of this.conns) {
      if (!c.alive) {
        this.log.warn({ hostId }, "host missed heartbeat; terminating link");
        c.socket.terminate();
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

  // ---- connectivity ----------------------------------------------------------------------

  private onDisconnected(hostId: string): void {
    this.log.info({ hostId }, "host disconnected");
    this.setConnectivity(hostId, "reconnecting");
    this.armUnreachable(hostId);
    this.hub.emit("host.disconnected", { hostId });
  }

  private armUnreachable(hostId: string): void {
    const prev = this.unreachableTimers.get(hostId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.unreachableTimers.delete(hostId);
      if (this.isConnected(hostId)) return;
      this.markUnreachable(hostId);
    }, this.opts.unreachableAfterMs);
    t.unref();
    this.unreachableTimers.set(hostId, t);
  }

  private markUnreachable(hostId: string): void {
    const host = this.store.hosts.get(hostId);
    if (!host) return;
    this.store.tx(() => {
      this.setConnectivity(hostId, "unreachable");
      for (const run of this.store.activeRunsOnHost(hostId)) {
        if (!run.sessionId) continue;
        this.attention.raise({
          reason: "host_unreachable",
          sessionId: run.sessionId,
          taskId: run.taskId,
          summary: `Host ${host.name} is unreachable`,
        });
      }
    });
    this.hub.emit("host.unreachable", { hostId });
  }

  private setConnectivity(hostId: string, connectivity: Host["connectivity"]): void {
    this.store.tx(() => {
      const host = this.store.hosts.get(hostId);
      if (!host) return;
      if (host.connectivity !== connectivity) {
        this.store.putHost({
          ...host,
          connectivity,
          lastSeenAt: connectivity === "reconnecting" ? this.store.nowIso() : host.lastSeenAt,
        });
      }
      this.syncSessionConnectivity(hostId, connectivity);
    });
  }

  private syncSessionConnectivity(hostId: string, connectivity: Host["connectivity"]): void {
    for (const s of this.store.sessions.list("host_id = ? AND archived_at IS NULL", [hostId])) {
      if (s.connectivity !== connectivity) this.store.putSession({ ...s, connectivity });
    }
  }

  // ---- event projection ------------------------------------------------------------------

  /** Dedupe, project and record one host event, all in one transaction. */
  applyHostEvent(hostId: string, hostSeq: number, ev: HostEvent): void {
    this.store.tx(() => {
      if (this.store.hasSeenHostEvent(hostId, ev.eventId)) {
        this.store.setAckedHostSeq(hostId, hostSeq);
        return;
      }
      const r = this.store.savepoint(() => this.project(hostId, ev));
      if (!r.ok) {
        const message = r.error instanceof Error ? r.error.message : String(r.error);
        this.log.warn({ hostId, type: ev.type, err: r.error }, "host event rejected");
        this.store.appendEvent(
          "diagnostic",
          { hostId, sessionId: ev.sessionId },
          {
            sessionId: null,
            adapterId: null,
            level: "error",
            message: `Rejected ${ev.type} event from host: ${message.slice(0, 500)}`,
            at: this.store.nowIso(),
          },
        );
      }
      this.store.markHostEventSeen(hostId, ev.eventId);
      this.store.setAckedHostSeq(hostId, hostSeq);
    });
  }

  private project(hostId: string, ev: HostEvent): void {
    const raw = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "session.updated":
        this.projectSession(hostId, ev, raw);
        return;
      case "transcript.item": {
        const item = TranscriptItem.parse(raw);
        const session = this.ownedSession(hostId, item.sessionId);
        this.store.upsertItem(item);
        this.store.appendEvent(
          "transcript.item",
          { hostId, sessionId: item.sessionId, projectId: session?.projectId ?? undefined },
          item,
        );
        return;
      }
      case "interaction.updated":
        this.projectInteraction(hostId, Interaction.parse(raw));
        return;
      case "panel.updated": {
        const panel = Panel.parse(raw);
        const session = this.ownedSession(hostId, panel.sessionId);
        if (panel.node === null)
          this.store.deletePanel(panel.sessionId, panel.adapterId, panel.slot);
        else this.store.upsertPanel(panel);
        this.store.appendEvent(
          "panel.updated",
          { hostId, sessionId: panel.sessionId, projectId: session?.projectId ?? undefined },
          panel,
        );
        return;
      }
      case "adapters.updated": {
        const adapters = AdapterInfo.array().parse(raw.adapters ?? []);
        this.store.setHostAdapters(hostId, adapters);
        const renderers = (raw.renderers ?? {}) as Record<string, unknown>;
        const rawAdapters = (Array.isArray(raw.adapters) ? raw.adapters : []) as Record<
          string,
          unknown
        >[];
        for (const a of adapters) {
          const fromList = rawAdapters.find((x) => x?.id === a.id);
          const html =
            (typeof renderers[a.id] === "string" ? (renderers[a.id] as string) : null) ??
            (typeof fromList?.webRendererHtml === "string" ? fromList.webRendererHtml : null);
          if (html !== null) this.store.setRenderer(hostId, a.id, html);
          else if (!a.webRenderer) this.store.setRenderer(hostId, a.id, null);
        }
        this.store.appendEvent("adapters.updated", { hostId }, { hostId, adapters });
        return;
      }
      case "diagnostic": {
        const d = Diagnostic.parse({ sessionId: null, adapterId: null, at: ev.at, ...raw });
        this.store.appendEvent("diagnostic", { hostId, sessionId: d.sessionId ?? undefined }, d);
        // Adapter `attention(reason, summary)` arrives as an extra `attention` key.
        const att = raw.attention as { reason?: unknown; summary?: unknown } | undefined;
        const sessionId = d.sessionId ?? ev.sessionId ?? null;
        if (att && typeof att === "object" && sessionId && this.ownedSession(hostId, sessionId)) {
          const given = att.reason ?? "needs_input";
          const reason = AttentionReason.safeParse(given);
          this.attention.raise({
            reason: reason.success ? reason.data : "unsupported_interaction",
            sessionId,
            summary:
              typeof att.summary === "string" && att.summary.trim()
                ? att.summary.slice(0, 500)
                : d.message,
          });
        }
        return;
      }
      case "workspace.updated":
        this.projectWorkspace(hostId, raw);
        return;
      case "workspace.removed": {
        // Hosts send `{id: <path>, path}`: match by path first, then by workspace id.
        const path = typeof raw.path === "string" ? raw.path : null;
        const key = String(raw.id ?? "");
        const ws =
          (path ? this.store.workspaceByPath(hostId, path) : undefined) ??
          this.store.workspaceByPath(hostId, key) ??
          this.store.workspaces.get(key);
        if (!ws) return;
        if (ws.hostId !== hostId)
          throw new SwitchyardError("forbidden", "Workspace of another host");
        this.store.removeWorkspace(ws);
        return;
      }
    }
  }

  private ownedSession(hostId: string, sessionId: string) {
    const s = this.store.sessions.get(sessionId);
    if (s && s.hostId !== hostId) {
      throw new SwitchyardError("forbidden", `Session ${sessionId} belongs to another host`);
    }
    return s;
  }

  private projectSession(hostId: string, ev: HostEvent, raw: Record<string, unknown>): void {
    const partial = Session.partial().parse(raw);
    const id = partial.id ?? ev.sessionId;
    if (!id) throw new SwitchyardError("invalid_request", "session.updated without id");
    const existing = this.ownedSession(hostId, id);
    const host = this.store.hosts.get(hostId);
    const connectivity = host?.connectivity ?? "connected";
    let next: Session;
    if (existing) {
      next = { ...existing, connectivity };
      for (const k of HOST_SESSION_FIELDS) {
        if (partial[k] !== undefined) (next as Record<string, unknown>)[k] = partial[k];
      }
      // Never lose a native handle we already know.
      if (!next.nativeHandle && existing.nativeHandle) next.nativeHandle = existing.nativeHandle;
    } else {
      const now = this.store.nowIso();
      const ws = partial.cwd ? this.store.workspaceByPath(hostId, partial.cwd) : undefined;
      next = Session.parse({
        title: "Untitled session",
        subtitle: null,
        workspaceId: ws?.id ?? null,
        projectId: ws?.projectId ?? null,
        cwd: "",
        nativeHandle: null,
        profileSnapshot:
          this.store.profiles.list(undefined, [], "created_at")[0] ?? FALLBACK_PROFILE,
        runtime: "idle",
        runtimeDetail: null,
        runId: null,
        taskId: null,
        provenance: "created",
        readOnly: false,
        lastActivityAt: now,
        archivedAt: null,
        queue: { steering: [], followUp: [] },
        stats: null,
        lastAssistantText: null,
        createdAt: now,
        ...partial,
        id,
        hostId,
        connectivity,
      });
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return;
    this.store.putSession(next);
    const prev = existing?.runtime;
    if ((prev === "running" || prev === "waiting_input") && next.runtime === "idle") {
      const settled = (raw.settled ?? null) as {
        aborted?: boolean;
        lastAssistantText?: string;
      } | null;
      const payload = {
        session: next,
        previousRuntime: prev,
        aborted: settled?.aborted ?? next.runtimeDetail === "aborted",
        lastAssistantText: settled?.lastAssistantText ?? next.lastAssistantText,
      };
      this.store.afterCommit(() => this.hub.emit("session.settled", payload));
    }
  }

  private projectInteraction(hostId: string, i: Interaction): void {
    const session = this.ownedSession(hostId, i.sessionId);
    const existing = this.store.interactions.get(i.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(i)) return;
    this.store.putInteraction(i, { hostId, projectId: session?.projectId ?? undefined });
    this.reconcileInputAttention(i);
  }

  /** Keep `needs_input` / `unsupported_interaction` attention in line with interaction state. */
  reconcileInputAttention(i: Interaction): void {
    if (i.state === "pending") {
      this.attention.raise({
        reason: "needs_input",
        sessionId: i.sessionId,
        interactionId: i.id,
        summary: i.title,
      });
      return;
    }
    if (i.state === "unsupported") {
      this.attention.raise({
        reason: "unsupported_interaction",
        sessionId: i.sessionId,
        interactionId: i.id,
        summary: i.title || "Terminal-only interface requested",
      });
      return;
    }
    const open = this.attention.open({ sessionId: i.sessionId, reason: "needs_input" })[0];
    if (!open || open.interactionId !== i.id) return;
    const other = this.store.interactions
      .list("session_id = ? AND state = 'pending'", [i.sessionId], "created_at")
      .find((x) => x.id !== i.id);
    if (other) {
      this.attention.raise({
        reason: "needs_input",
        sessionId: other.sessionId,
        interactionId: other.id,
        summary: other.title,
      });
    } else {
      this.attention.resolve({ sessionId: i.sessionId, reason: "needs_input" });
    }
  }

  private projectWorkspace(hostId: string, raw: Record<string, unknown>): void {
    const partial = Workspace.partial().parse(raw);
    const existing =
      (partial.id ? this.store.workspaces.get(partial.id) : undefined) ??
      (partial.path ? this.store.workspaceByPath(hostId, partial.path) : undefined);
    if (!existing) {
      const full = Workspace.safeParse({ ...raw, hostId });
      if (full.success) {
        this.store.putWorkspace(full.data);
        return;
      }
      if (partial.path) {
        const key = `${hostId}\u0000${partial.path}`;
        this.workspaceBuffer.set(key, { ...(this.workspaceBuffer.get(key) ?? {}), ...partial });
        if (this.workspaceBuffer.size > 200) {
          this.workspaceBuffer.delete(this.workspaceBuffer.keys().next().value!);
        }
      }
      return;
    }
    if (existing.hostId !== hostId)
      throw new SwitchyardError("forbidden", "Workspace of another host");
    const next: Workspace = {
      ...existing,
      branch: partial.branch !== undefined ? partial.branch : existing.branch,
      git: partial.git ?? existing.git,
      setup: partial.setup ?? existing.setup,
      updatedAt: partial.updatedAt ?? this.store.nowIso(),
    };
    if (JSON.stringify(next) === JSON.stringify(existing)) return;
    this.store.putWorkspace(next);
  }

  /** Merge buffered host updates into a newly recorded workspace. */
  takeBufferedWorkspace(hostId: string, path: string): Partial<Workspace> | undefined {
    const key = `${hostId}\u0000${path}`;
    const v = this.workspaceBuffer.get(key);
    this.workspaceBuffer.delete(key);
    return v as Partial<Workspace> | undefined;
  }
}
