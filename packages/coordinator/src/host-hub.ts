import {
  AdapterInfo,
  AGENT_FRAME_MAX_BYTES,
  AgentRequestFrame,
  AgentResultFrame,
  AttentionReason,
  CompletedUsageWatermark,
  type CoordinatorToHost,
  Diagnostic,
  type Host,
  HostAgentRequestFrame,
  HostCommand,
  type HostEvent,
  HostToCoordinator,
  type HostToolPolicyContext,
  Interaction,
  newId,
  Panel,
  PROTOCOL_VERSION,
  type Profile,
  type ProviderUsage,
  type Receipt,
  Session,
  StreamDelta,
  SwitchyardError,
  type TermCoordinatorMsg,
  type TermServerToViewer,
  TranscriptItem,
  UNTITLED_SESSION_TITLE,
  Workspace,
} from "@switchyard/protocol";
import type { Logger } from "pino";
import type { WebSocket } from "ws";
import type { AttentionService } from "./attention.js";
import { safeEqualHex, sha256 } from "./auth.js";
import { COORDINATOR_VERSION } from "./context.js";
import type { EventHub } from "./event-hub.js";
import { linkSubagentItem } from "./sessions/subagents.js";
import type { Store } from "./store.js";

export interface HostHubOptions {
  unreachableAfterMs: number;
  commandTimeoutMs: number;
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
}

// biome-ignore lint/suspicious/noConfusingVoidType: A ready synchronous guard returns void.
type BeforeSend = () => void | { defer: true; reason: string };

interface Pending {
  hostId: string;
  frame: string;
  command: HostCommand;
  beforeSend?: BeforeSend;
  deferred: boolean;
  resolve: (r: Receipt) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  socket: WebSocket;
  alive: boolean;
  features: Set<string>;
}

export type AgentRequestHandler = (
  authenticatedHostId: string,
  frame: AgentRequestFrame,
  hostPolicyContext?: HostToolPolicyContext,
) => Promise<AgentResultFrame>;

// Negotiated support is a snapshot of initialized implementation availability at hello.

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
  "model",
  "thinking",
  "compacting",
  "promptCache",
  "lastAssistantText",
  "lastActivityAt",
  "terminal",
  "bridge",
] as const;

/** Where host terminal frames go (the coordinator's TerminalHub). */
export interface TerminalSink {
  frame(hostId: string, streamId: string, msg: TermServerToViewer): void;
  disconnected(hostId: string): void;
}

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
  private terminalSink: TerminalSink | null = null;
  private agentHandler: AgentRequestHandler | null = null;
  private availableAgentFeatures: ReadonlySet<string> = new Set();

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

  setTerminalSink(sink: TerminalSink): void {
    this.terminalSink = sink;
  }

  /** Separate request lane: never await agent tools behind host events or command receipts. */
  setAgentHandler(handler: AgentRequestHandler | null): void {
    this.agentHandler = handler;
    this.availableAgentFeatures = handler ? new Set(["agentRequests.v1"]) : new Set();
  }

  /** Affects future hellos only; never mutate an established connection's negotiation. */
  setAvailableAgentFeatures(features: ReadonlySet<string>): void {
    if (features.has("policies.v1") && !features.has("agentRequests.v1"))
      throw new Error("policies.v1 requires agentRequests.v1");
    if (features.size && !this.agentHandler) throw new Error("Agent features require a handler");
    this.availableAgentFeatures = new Set(features);
  }

  negotiatedFeatures(hostId: string): ReadonlySet<string> {
    return new Set(this.conns.get(hostId)?.features);
  }

  /** Send a terminal relay frame; false when the host is not connected. */
  sendTerm(hostId: string, streamId: string, msg: TermCoordinatorMsg): boolean {
    const conn = this.conns.get(hostId);
    if (!conn || conn.socket.readyState !== WsOpen) return false;
    this.sendFrame(conn.socket, { type: "term", streamId, msg });
    return true;
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
    opts: {
      timeoutMs?: number;
      commandId?: string;
      preserveLaunchCommand?: boolean;
      beforeSend?: BeforeSend;
    } = {},
  ): Promise<Receipt> {
    let parsed = HostCommand.parse(command);
    const conn = this.conns.get(hostId);
    if (!conn || conn.socket.readyState !== WsOpen) {
      const name = this.store.hosts.get(hostId)?.name ?? hostId;
      return Promise.reject(
        new SwitchyardError("host_unreachable", `Host ${name} is not connected`, { hostId }),
      );
    }
    if (
      (parsed.type === "session.start" || parsed.type === "dispatch.start") &&
      !parsed.policyRequired &&
      !opts.preserveLaunchCommand &&
      !conn.features.has("policies.v1")
    ) {
      // Only a fresh optional command can omit the field. Never rewrite a persisted launch
      // on replacement/reconnect, even from explicit false to absent.
      const { policyRequired: _policyRequired, ...legacy } = parsed;
      parsed = legacy;
    }
    if (!this.supportsCommand(conn, parsed)) {
      return Promise.reject(
        new SwitchyardError("unsupported_capability", `Host does not support ${parsed.type}`),
      );
    }
    const commandId = opts.commandId ?? newId("cmd");
    if (parsed.type === "session.prompt" && /^cont_.+_\d+$/.test(commandId) && !opts.beforeSend) {
      return Promise.reject(
        new SwitchyardError("stale_control", "Continuation requires a send guard"),
      );
    }
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
      const pending: Pending = {
        hostId,
        frame,
        command: parsed,
        beforeSend: opts.beforeSend,
        deferred: false,
        resolve,
        reject,
        timer,
      };
      this.pending.set(commandId, pending);
      this.sendPending(commandId, pending, conn.socket);
    });
  }

  /** Retry only held frames, never commands already sent and awaiting a receipt. */
  retryDeferred(hostId: string): void {
    const conn = this.conns.get(hostId);
    if (!conn || !this.isCurrentSocket(hostId, conn.socket)) return;
    for (const [id, pending] of [...this.pending]) {
      if (pending.hostId === hostId && pending.deferred) {
        this.sendPending(id, pending, conn.socket);
      }
    }
  }

  private sendPending(commandId: string, pending: Pending, socket: WebSocket): void {
    // A reconnect snapshot or commit callback may outlive a timeout/withdrawal/receipt.
    if (this.pending.get(commandId) !== pending || !this.isCurrentSocket(pending.hostId, socket))
      return;
    // A guard may commit store writes: do not recursively pump this frame from those writes.
    pending.deferred = false;
    try {
      const readiness = pending.beforeSend?.();
      if (readiness?.defer) {
        pending.deferred = true;
        return;
      }
    } catch (error) {
      clearTimeout(pending.timer);
      if (this.pending.get(commandId) === pending) this.pending.delete(commandId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // The synchronous guard may itself have withdrawn the command or closed the connection.
    if (this.pending.get(commandId) === pending && this.isCurrentSocket(pending.hostId, socket))
      socket.send(pending.frame);
  }

  private supportsCommand(conn: Conn, command: HostCommand): boolean {
    if (command.type === "session.deliverMessage" || command.type === "session.messageStatus") {
      return conn.features.has("agentRequests.v1");
    }
    if (
      (command.type === "session.start" || command.type === "dispatch.start") &&
      command.policyRequired !== undefined
    ) {
      return conn.features.has("agentRequests.v1") && conn.features.has("policies.v1");
    }
    return true;
  }

  /**
   * Withdraw a command still awaiting its receipt from a host that is not connected, so it is not
   * re-sent on reconnect. Its caller sees `host_unreachable` with `{withdrawn: true}`. Returns
   * whether it was withdrawn (a connected host may already be running it: nothing is withdrawn).
   */
  withdraw(commandId: string, reason: string): boolean {
    const p = this.pending.get(commandId);
    if (!p || this.isConnected(p.hostId)) return false;
    clearTimeout(p.timer);
    this.pending.delete(commandId);
    p.reject(new SwitchyardError("host_unreachable", reason, { commandId, withdrawn: true }));
    return true;
  }

  /** Withdraw every pending command for a disconnected host whose id matches. Returns the count. */
  withdrawMatching(hostId: string, match: (commandId: string) => boolean, reason: string): number {
    if (this.isConnected(hostId)) return 0;
    let n = 0;
    for (const [id, p] of this.pending) {
      if (p.hostId !== hostId || !match(id)) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new SwitchyardError("host_unreachable", reason, { commandId: id, withdrawn: true }));
      n++;
    }
    return n;
  }

  /** `send` and unwrap: returns `result` or throws a SwitchyardError with the host's code. */
  async request<T = unknown>(
    hostId: string,
    command: HostCommand,
    opts: { timeoutMs?: number; commandId?: string; beforeSend?: BeforeSend } = {},
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
      if (hostId && !this.isCurrentSocket(hostId, socket)) return;
      let json: unknown;
      let frame: HostToCoordinator;
      try {
        json = JSON.parse(raw.toString());
        const loose = json as { type?: unknown } | null;
        if (
          hostId &&
          loose?.type === "agent.request" &&
          Buffer.byteLength(raw.toString()) > AGENT_FRAME_MAX_BYTES
        ) {
          this.invalidAgentRequest(hostId, socket, json, "Agent request exceeds 128 KiB");
          return;
        }
        frame = HostToCoordinator.parse(json);
      } catch (err) {
        this.log.warn({ err, hostId }, "invalid host frame");
        if (!hostId) {
          this.reject(socket, "invalid_request", "Expected hello");
        } else {
          this.invalidAgentRequest(hostId, socket, json, "Invalid agent request");
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
      if (!this.isCurrentSocket(hostId, socket)) return;
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
    const features = new Set(
      [...this.availableAgentFeatures].filter((f) => hello.features?.includes(f)),
    );
    this.conns.set(hostId, { socket, alive: true, features });
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
      ...(hello.features === undefined ? {} : { features: [...features] }),
    });
    // Snapshot first: the setControl frames sent below would otherwise go out twice.
    const resend = [...this.pending.entries()].filter(([id, p]) => {
      if (p.hostId !== hostId) return false;
      if (this.supportsCommand(this.conns.get(hostId)!, p.command)) return true;
      // A replacement may be older than the original host. Do not replay new commands to it.
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(
        new SwitchyardError("unsupported_capability", "Replacement host lacks command support"),
      );
      return false;
    });
    const sent = new Set<string>();
    // The host learns current control before any re-sent automated command can run.
    for (const run of this.store.activeRunsOnHost(hostId)) {
      if (!run.sessionId || run.state === "queued") continue;
      const commandId = `ctl_${run.dispatchKey}_${run.controlRevision}`;
      const existing = this.pending.get(commandId);
      if (existing) {
        this.sendPending(commandId, existing, socket);
        sent.add(commandId);
        continue;
      }
      this.send(
        hostId,
        {
          type: "session.setControl",
          sessionId: run.sessionId,
          controlRevision: run.controlRevision,
          mode: run.controlMode,
        },
        { commandId },
      ).catch((err) =>
        this.log.warn({ err, hostId, runId: run.id }, "session.setControl on reconnect failed"),
      );
    }
    // Welcome pumps held frames as well as replaying unacknowledged writes, once each.
    for (const [id, p] of resend) if (!sent.has(id)) this.sendPending(id, p, socket);
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
      case "agent.request":
        void this.onAgentRequest(hostId, socket, frame).catch((err) =>
          this.log.warn({ err, hostId, requestId: frame.requestId }, "agent response failed"),
        );
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
      case "usage": {
        const host = this.store.hosts.get(hostId);
        if (!host) return;
        const strip = (u: ProviderUsage[] | undefined) =>
          JSON.stringify((u ?? []).map(({ fetchedAt: _f, ...r }) => r));
        if (strip(host.usage) === strip(frame.usage)) return;
        this.store.tx(() => this.store.putHost({ ...host, usage: frame.usage }));
        return;
      }
      case "term":
        this.terminalSink?.frame(hostId, frame.streamId, frame.msg);
        return;
    }
  }

  private isCurrentSocket(hostId: string, socket: WebSocket): boolean {
    const host = this.store.hosts.get(hostId);
    return (
      this.conns.get(hostId)?.socket === socket &&
      socket.readyState === WsOpen &&
      !!host &&
      !host.revokedAt
    );
  }

  /** Malformed requests with usable correlation ids receive an error, not a link rejection. */
  private invalidAgentRequest(
    hostId: string,
    socket: WebSocket,
    json: unknown,
    message: string,
  ): void {
    if (!this.isCurrentSocket(hostId, socket)) return;
    if ((json as { type?: unknown } | null)?.type !== "agent.request") return;
    const correlation = json as Record<string, unknown>;
    const ids = AgentRequestFrame.pick({ requestId: true, runtimeId: true }).safeParse({
      requestId: correlation.requestId,
      runtimeId: correlation.runtimeId,
    });
    if (!ids.success) return;
    this.sendFrame(socket, {
      type: "agent.result",
      ...ids.data,
      ok: false,
      error: { code: "invalid_request", message },
    });
  }

  private async onAgentRequest(
    hostId: string,
    socket: WebSocket,
    input: HostAgentRequestFrame,
  ): Promise<void> {
    let frame = input;
    let response: AgentResultFrame;
    try {
      if (!this.isCurrentSocket(hostId, socket)) return;
      // Only the authenticated host wire may carry this proof. Reparse, then separate it
      // before constructing the strict Pi/base frame passed to the service.
      const { policyContext, ...base } = HostAgentRequestFrame.parse(input);
      frame = AgentRequestFrame.parse(base);
      const features = this.conns.get(hostId)!.features;
      if (
        !features.has("agentRequests.v1") ||
        (frame.method.startsWith("policy.") && !features.has("policies.v1"))
      ) {
        throw new SwitchyardError(
          "unsupported_capability",
          "Agent request feature was not negotiated",
        );
      }
      const session = this.ownedSession(hostId, frame.sessionId);
      if (!session) throw new SwitchyardError("not_found", `Session ${frame.sessionId} not found`);
      if (
        (frame.method === "task.create" || frame.method === "message.send") &&
        !frame.toolCallId
      ) {
        throw new SwitchyardError("invalid_request", "Mutating agent tools require toolCallId");
      }
      if (!this.agentHandler)
        throw new SwitchyardError("unsupported_capability", "Agent requests are unavailable");
      response = AgentResultFrame.parse(await this.agentHandler(hostId, frame, policyContext));
      if (response.requestId !== frame.requestId || response.runtimeId !== frame.runtimeId) {
        throw new SwitchyardError("internal", "Agent handler returned mismatched correlation ids");
      }
      if (Buffer.byteLength(JSON.stringify(response)) > AGENT_FRAME_MAX_BYTES) {
        throw new SwitchyardError("invalid_request", "Agent result exceeds 128 KiB");
      }
    } catch (err) {
      const error =
        err instanceof SwitchyardError
          ? err.toBody()
          : { code: "internal" as const, message: "Agent request failed" };
      response = {
        type: "agent.result",
        requestId: frame.requestId,
        runtimeId: frame.runtimeId,
        ok: false,
        error,
      };
      // Error details are also untrusted output and must fit the transport's size bound.
      try {
        if (Buffer.byteLength(JSON.stringify(response)) > AGENT_FRAME_MAX_BYTES)
          throw new Error("oversized error");
      } catch {
        response = {
          type: "agent.result",
          requestId: frame.requestId,
          runtimeId: frame.runtimeId,
          ok: false,
          error: { code: "invalid_request", message: "Invalid agent error result" },
        };
      }
    }
    // A slow policy status/ASK must never reply over a replacement or revoked connection.
    if (this.isCurrentSocket(hostId, socket)) this.sendFrame(socket, response);
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
    this.terminalSink?.disconnected(hostId);
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
        let item = TranscriptItem.parse(raw);
        const session = this.ownedSession(hostId, item.sessionId);
        if (item.kind === "subagent") item = linkSubagentItem(this.store, hostId, session, item);
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
      case "workspace.deleted": {
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
        this.store.archiveWorkspace(ws);
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
        title: UNTITLED_SESSION_TITLE,
        subtitle: null,
        workspaceId: ws?.id ?? null,
        projectId: ws?.projectId ?? null,
        cwd: "",
        nativeHandle: null,
        profileSnapshot:
          this.store.profiles.list(undefined, [], "created_at, rowid")[0] ?? FALLBACK_PROFILE,
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
    if (next.bridge) {
      // Bind owns native identity even before Pi has created a session file. Preserve it across
      // partial/older host projections whose bridge schema does not yet include that field.
      const bridge = next.bridge as NonNullable<Session["bridge"]> & { nativeSessionId?: string };
      const previousBridge = existing?.bridge as typeof bridge | undefined;
      if (bridge.runtimeId === previousBridge?.runtimeId && previousBridge?.nativeSessionId) {
        next.bridge = {
          ...bridge,
          nativeSessionId: previousBridge.nativeSessionId,
        } as typeof bridge;
      }
      if (!this.negotiatedFeatures(hostId).has("agentRequests.v1")) {
        next.bridge = { ...next.bridge!, agentTools: false, messageDelivery: false };
      }
      const host = this.store.hosts.require(hostId);
      const protection =
        this.negotiatedFeatures(hostId).has("policies.v1") &&
        host.capabilities?.agentRequests === true &&
        host.capabilities.policies === true &&
        (next.nativeHandle === null ||
          next.nativeHandle.sessionId === next.bridge!.nativeSessionId) &&
        this.store.db
          .prepare(`SELECT 1 FROM policy_runtime_boundaries
          WHERE session_id=? AND native_session_id=? AND runtime_id=? AND host_id=?`)
          .get(id, next.bridge!.nativeSessionId, next.bridge!.runtimeId, hostId);
      if (!protection)
        next.bridge = {
          ...next.bridge!,
          policyState:
            next.bridge!.policyState === "active" ? "unsupported" : next.bridge!.policyState,
          policyPhases: [],
        };
    }
    const prev = existing?.runtime;
    const finished = (prev === "running" || prev === "waiting_input") && next.runtime === "idle";
    const settled = (raw.settled ?? null) as {
      aborted?: boolean;
      lastAssistantText?: string;
      watermark?: unknown;
    } | null;
    const completed = CompletedUsageWatermark.safeParse(settled?.watermark);
    const watermark =
      finished &&
      completed.success &&
      completed.data &&
      partial.stats?.watermark &&
      completed.data.runtimeId === partial.stats.watermark.runtimeId &&
      completed.data.settleSeq === partial.stats.watermark.settleSeq
        ? completed.data
        : undefined;
    const previousWatermark = existing?.stats?.watermark;
    const unchangedWatermark =
      previousWatermark &&
      next.stats?.watermark &&
      previousWatermark.runtimeId === next.stats.watermark.runtimeId &&
      previousWatermark.settleSeq === next.stats.watermark.settleSeq &&
      existing?.stats?.tokens === next.stats.tokens &&
      existing?.stats?.costUsd === next.stats.costUsd;
    if (next.stats && (next.runtime !== "idle" || (finished ? !watermark : !unchangedWatermark))) {
      // Old hosts still settle, but inherited, busy or mismatched totals never prove freshness.
      const { watermark: _, ...stats } = next.stats;
      next.stats = stats;
    }
    const failed = next.runtime === "failed" && prev !== "failed";
    if ((finished || failed) && !next.unreadSince && !this.beingViewed(id)) {
      next.unreadSince = this.store.nowIso();
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return;
    this.store.putSession(next);
    if (partial.bridge !== undefined) {
      // Recheck the current guard only after the bridge projection is durable.
      this.store.afterCommit(() => this.retryDeferred(hostId));
    }
    if ((prev === "running" || prev === "waiting_input") && next.runtime === "idle") {
      const payload = {
        session: next,
        ...(watermark ? { watermark } : {}),
        previousRuntime: prev,
        aborted: settled?.aborted ?? next.runtimeDetail === "aborted",
        lastAssistantText: settled?.lastAssistantText ?? next.lastAssistantText,
      };
      // Durable with the projection: a coordinator restart before the run is evaluated finds
      // an unevaluated settle (see RunsService.recover).
      if (next.runId) this.store.noteRunSettle(next.runId);
      this.store.afterCommit(() => this.hub.emit("session.settled", payload));
    }
  }

  /** Whether a device has this session open in the foreground right now. */
  private beingViewed(sessionId: string): boolean {
    const now = this.store.nowIso();
    return this.store
      .listPresence()
      .some(
        (p) =>
          p.viewingSessionId === sessionId && p.foregroundUntil !== null && p.foregroundUntil > now,
      );
  }

  private projectInteraction(hostId: string, i: Interaction): void {
    const session = this.ownedSession(hostId, i.sessionId);
    const existing = this.store.interactions.get(i.id);
    if (i.permission?.kind === "policy" || existing?.permission?.kind === "policy") {
      throw new SwitchyardError("forbidden", "Policy interactions are coordinator-owned");
    }
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
      // A person chose one of its alternatives (stop or message): nothing is waiting any more.
      if (i.resolution) {
        this.attention.resolve({
          sessionId: i.sessionId,
          reason: "unsupported_interaction",
          interactionId: i.id,
        });
        return;
      }
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
