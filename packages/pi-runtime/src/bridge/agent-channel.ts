import { randomUUID } from "node:crypto";

export type AgentContextIds = { humanInputId: string | null; causalMessageId: string | null };
export type BridgeCapabilities = {
  agentTools: boolean;
  messageDelivery: boolean;
  editorDraftGuard: boolean;
  toolPolicy: boolean;
};
export type BridgeConfiguration = {
  version: 1;
  sessionId: string;
  runtimeId: string;
  nativeSessionId: string;
  bindingId: string;
  features: string[];
  coordinatorConnected: boolean;
  policyRequired: boolean;
  sessionUrl: string | null;
};
export type BridgeCommandHeader = {
  type: "bridge.command";
  requestId: string;
  runtimeId: string;
  nativeSessionId: string;
  bindingId: string;
};
export type AgentBindingIdentity = {
  sessionId: string;
  runtimeId: string;
  nativeSessionId: string;
  bindingId: string;
};
export type RequestOptions = {
  toolCallId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Local-only invocation fence; never encoded as a caller-controlled wire field. */
  binding?: AgentBindingIdentity;
  /** Legacy binding-id-only fence. New callers must pin the complete identity. */
  bindingId?: string;
};
export type ReadyOptions = {
  require: "agentRequests" | "policies";
  binding?: AgentBindingIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type DeliveryHandler = (
  args: unknown,
  envelope: BridgeCommandHeader,
) => unknown | Promise<unknown>;
type PolicyState = "initializing" | "active" | "unsupported" | "lost";
export interface AgentChannel {
  readonly runtimeId: string;
  snapshot(): {
    configuration: BridgeConfiguration | null;
    policyRequired: boolean;
    policyState: PolicyState;
  };
  announce(): void;
  onConnect(): void;
  onDisconnect(): void;
  onControlAttached(): void;
  receive(record: unknown): boolean;
  waitReady(options: ReadyOptions): Promise<BridgeConfiguration>;
  request<T = unknown>(
    method:
      | "task.create"
      | "message.send"
      | "inbox.read"
      | "policy.evaluate"
      | "policy.status"
      | "policy.cancel",
    args: unknown,
    options?: RequestOptions,
  ): Promise<T>;
  registerCommand(
    method: "delivery.accept" | "delivery.status",
    handler: DeliveryHandler,
  ): () => void;
  noteHumanInput(humanInputId?: string): string;
  close(): void;
}

export function channelError(
  code: string,
  message: string,
  details?: unknown,
): Error & { code: string; details?: unknown } {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

export function createAgentChannel(options: {
  send: (record: Record<string, unknown>) => boolean;
  getContext: () => any | null;
  appendEntry: (customType: string, data: unknown) => void;
  mode: "rpc" | "terminal";
  getCapabilities: () => BridgeCapabilities;
  policyRequired: boolean;
  now?: () => number;
}): AgentChannel {
  const runtimeId = randomUUID();
  const now = options.now ?? Date.now;
  let configuration: BridgeConfiguration | null = null;
  let required = options.policyRequired;
  let connected = false;
  let closed = false;
  let native: string | null = null;
  let lastBinding: AgentBindingIdentity | null = null;
  // A controller/native replacement is irreversible for already captured pins, even if
  // a delayed configure later tries to restore an old identity (A -> B -> A).
  const retiredBindings = new Set<string>();
  const bindingKey = (b: AgentBindingIdentity) =>
    JSON.stringify([b.sessionId, b.runtimeId, b.nativeSessionId, b.bindingId]);
  const retireBinding = () => {
    if (lastBinding) retiredBindings.add(bindingKey(lastBinding));
  };
  const handlers = new Map<string, DeliveryHandler>();
  const changes = new Set<() => void>();
  const pending = new Map<string, { bindingId: string; resolve: (record: any) => void }>();
  let activeRequests = 0;
  const wake = () => {
    for (const cb of [...changes]) cb();
  };
  const currentNative = (): string | null =>
    options.getContext()?.sessionManager?.getSessionId?.() || null;
  const invalidate = () => {
    configuration = null;
    for (const p of pending.values()) p.resolve(null);
    pending.clear();
    wake();
  };
  const syncNative = () => {
    const value = currentNative();
    if (native !== value) {
      retireBinding();
      native = value;
      invalidate();
    }
    return value;
  };
  const assertBinding = (binding?: AgentBindingIdentity) => {
    if (!binding) return;
    const current = syncNative();
    if (binding.nativeSessionId !== current)
      throw channelError("stale_control", "Native session changed");
    if (
      binding.runtimeId !== runtimeId ||
      retiredBindings.has(bindingKey(binding)) ||
      (lastBinding && bindingKey(lastBinding) !== bindingKey(binding)) ||
      (configuration && bindingKey(configuration) !== bindingKey(binding))
    )
      throw channelError("stale_control", "Bridge binding changed during tool authorization");
  };
  const contextIds = (): AgentContextIds => {
    const result: AgentContextIds = { humanInputId: null, causalMessageId: null };
    const entries = options.getContext()?.sessionManager?.getBranch?.() ?? [];
    for (const e of entries) {
      if (
        e?.type === "custom" &&
        e.customType === "switchyard-human-input" &&
        typeof e.data?.humanInputId === "string"
      ) {
        result.humanInputId = e.data.humanInputId;
        result.causalMessageId = null;
      }
      const m = e?.type === "message" || e?.type === "custom_message" ? (e.message ?? e) : null;
      if (
        (m?.customType === "switchyard-inbox" || m?.customType === "switchyard-completion") &&
        typeof m.details?.deliveryId === "string"
      )
        result.causalMessageId = m.details.deliveryId;
    }
    return result;
  };
  const state = (): PolicyState => {
    if (!configuration) return "initializing";
    const caps = options.getCapabilities();
    if (
      !(
        caps.toolPolicy &&
        configuration.features.includes("agentRequests.v1") &&
        configuration.features.includes("policies.v1")
      )
    )
      return "unsupported";
    return connected && configuration.coordinatorConnected ? "active" : "lost";
  };
  const usable = (c: BridgeConfiguration, feature: ReadyOptions["require"]) =>
    feature === "policies"
      ? state() !== "unsupported"
      : options.getCapabilities().agentTools && c.features.includes("agentRequests.v1");
  const delay = (deadline: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (closed) return reject(channelError("host_unreachable", "Channel closed"));
      if (signal?.aborted) return reject(channelError("conflict", "Request canceled"));
      const remaining = deadline - now();
      if (remaining <= 0)
        return reject(channelError("timeout", "Coordinator communication timed out"));
      const cleanup = () => {
        clearTimeout(timer);
        changes.delete(changed);
        signal?.removeEventListener("abort", abort);
      };
      const changed = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(channelError("conflict", "Request canceled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(channelError("timeout", "Coordinator communication timed out"));
      }, remaining);
      changes.add(changed);
      signal?.addEventListener("abort", abort, { once: true });
    });
  const deadlineFor = (ms?: number) =>
    now() + Math.min(30000, Math.max(1, Number.isFinite(ms) ? ms! : 30000));
  const ready = async (
    feature: ReadyOptions["require"],
    deadline: number,
    signal?: AbortSignal,
    expectedNative?: string | null,
    binding?: AgentBindingIdentity,
    pinFirst = false,
  ) => {
    // Capture startup readiness synchronously on the state change, not in a later
    // promise continuation that could already see a replacement controller.
    const capture = () => {
      if (
        pinFirst &&
        !binding &&
        configuration &&
        connected &&
        configuration.coordinatorConnected &&
        usable(configuration, feature)
      ) {
        const { sessionId, runtimeId, nativeSessionId, bindingId } = configuration;
        binding = { sessionId, runtimeId, nativeSessionId, bindingId };
      }
    };
    if (pinFirst) changes.add(capture);
    capture();
    try {
      while (true) {
        if (closed) throw channelError("host_unreachable", "Channel closed");
        if (signal?.aborted) throw channelError("conflict", "Request canceled");
        if (now() >= deadline) throw channelError("timeout", "Coordinator communication timed out");
        const current = syncNative();
        assertBinding(binding);
        if (expectedNative && current !== expectedNative)
          throw channelError("conflict", "Native session changed");
        if (configuration && !usable(configuration, feature))
          throw channelError(
            "unsupported_capability",
            "Coordinator or bridge does not support this feature",
          );
        if (configuration && connected && configuration.coordinatorConnected) return configuration;
        await delay(deadline, signal);
      }
    } finally {
      changes.delete(capture);
    }
  };
  const announce = () => {
    const id = syncNative();
    if (!id || closed || !connected) return;
    options.send({
      type: "agent.hello",
      version: 1,
      runtimeId,
      nativeSessionId: id,
      sessionFile: options.getContext()?.sessionManager?.getSessionFile?.() ?? null,
      pid: process.pid,
      mode: options.mode,
      capabilities: options.getCapabilities(),
      context: contextIds(),
    });
  };
  const noteHumanInput = (id = randomUUID()) => {
    const entries = options.getContext()?.sessionManager?.getBranch?.() ?? [];
    const existing = entries.some(
      (entry: any) =>
        entry?.type === "custom" &&
        entry.customType === "switchyard-human-input" &&
        entry.data?.humanInputId === id,
    );
    if (!existing) options.appendEntry("switchyard-human-input", { version: 1, humanInputId: id });
    return id;
  };
  const receipt = (r: any, result: unknown, error?: any) => {
    if (closed) return;
    options.send({
      type: "bridge.receipt",
      requestId: r.requestId,
      runtimeId: r.runtimeId,
      nativeSessionId: r.nativeSessionId,
      bindingId: r.bindingId,
      ...(error
        ? {
            ok: false,
            error: {
              code: error.code ?? "internal",
              message: error.message ?? String(error),
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          }
        : { ok: true, result }),
    });
  };
  const channel: AgentChannel = {
    runtimeId,
    snapshot() {
      syncNative();
      return { configuration, policyRequired: required, policyState: state() };
    },
    announce,
    onConnect() {
      if (closed) return;
      connected = true;
      wake();
      announce();
    },
    onDisconnect() {
      connected = false;
      invalidate();
    },
    onControlAttached() {
      retireBinding();
      invalidate();
      announce();
    },
    receive(record) {
      if (!record || typeof record !== "object") return false;
      const r = record as any;
      if (r.type === "agent.result") {
        const p = pending.get(r.requestId);
        if (
          p &&
          r.runtimeId === runtimeId &&
          r.bindingId === p.bindingId &&
          configuration?.bindingId === p.bindingId &&
          typeof r.ok === "boolean"
        ) {
          pending.delete(r.requestId);
          p.resolve(r);
        }
        return true;
      }
      if (r.type !== "bridge.command") return false;
      const validId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200;
      if (
        ![r.requestId, r.runtimeId, r.nativeSessionId, r.bindingId].every(validId) ||
        r.runtimeId !== runtimeId ||
        r.nativeSessionId !== syncNative()
      )
        return true;
      if (r.method !== "configure" && (!configuration || r.bindingId !== configuration.bindingId))
        return true;
      void (async () => {
        try {
          if (r.method === "configure") {
            const c = r.args;
            if (
              c?.version !== 1 ||
              c.runtimeId !== runtimeId ||
              c.nativeSessionId !== native ||
              c.bindingId !== r.bindingId ||
              !validId(c.sessionId) ||
              !Array.isArray(c.features) ||
              !c.features.every((f: unknown) => typeof f === "string") ||
              typeof c.coordinatorConnected !== "boolean" ||
              typeof c.policyRequired !== "boolean" ||
              !(c.sessionUrl === null || typeof c.sessionUrl === "string")
            )
              throw channelError("invalid_request", "Invalid bridge configuration");
            if (retiredBindings.has(bindingKey(c)))
              throw channelError("stale_control", "Bridge controller binding has been replaced");
            if (lastBinding && bindingKey(lastBinding) !== bindingKey(c)) retireBinding();
            invalidate();
            configuration = { ...c, features: [...c.features] };
            lastBinding = {
              sessionId: c.sessionId,
              runtimeId: c.runtimeId,
              nativeSessionId: c.nativeSessionId,
              bindingId: c.bindingId,
            };
            required ||= c.policyRequired;
            wake();
            const caps = options.getCapabilities();
            const enabled = caps.agentTools && c.features.includes("agentRequests.v1");
            receipt(r, {
              configured: true,
              agentTools: enabled,
              messageDelivery:
                caps.messageDelivery &&
                caps.editorDraftGuard &&
                c.features.includes("agentRequests.v1"),
              policyRequired: required,
              policyState: state(),
              policyPhases: state() === "active" ? ["tool_call", "request"] : [],
            });
          } else if (r.method === "connection.update") {
            if (typeof r.args?.connected !== "boolean")
              throw channelError("invalid_request", "Invalid connection state");
            configuration!.coordinatorConnected = r.args.connected;
            if (!r.args.connected) {
              for (const p of pending.values()) p.resolve(null);
              pending.clear();
            }
            wake();
            receipt(r, { connected: r.args.connected });
          } else if (r.method === "input.human") {
            if (!validId(r.args?.humanInputId))
              throw channelError("invalid_request", "Invalid human input id");
            noteHumanInput(r.args.humanInputId);
            receipt(r, { humanInputId: r.args.humanInputId });
          } else {
            const handler = handlers.get(r.method);
            if (!handler)
              throw channelError("unsupported_capability", "Unsupported bridge command");
            const caps = options.getCapabilities();
            if (
              !caps.messageDelivery ||
              !caps.editorDraftGuard ||
              !configuration!.features.includes("agentRequests.v1")
            )
              throw channelError("unsupported_capability", "Message delivery is unavailable");
            receipt(r, await handler(r.args, r));
          }
        } catch (error) {
          receipt(r, null, error);
        }
      })();
      return true;
    },
    waitReady(o) {
      const binding = o.binding ? { ...o.binding } : undefined;
      return ready(o.require, deadlineFor(o.timeoutMs), o.signal, syncNative(), binding, true);
    },
    async request(method, args, opts = {}) {
      if (activeRequests >= 64)
        throw channelError("rate_limited", "Too many pending agent requests");
      activeRequests++;
      try {
        const deadline = deadlineFor(opts.timeoutMs);
        const deadlineAt = new Date(deadline).toISOString();
        const feature = method.startsWith("policy.") ? "policies" : "agentRequests";
        const binding = opts.binding ? { ...opts.binding } : undefined;
        let initialNative = syncNative();
        while (true) {
          assertBinding(binding);
          const c = await ready(feature, deadline, opts.signal, initialNative, binding);
          assertBinding(binding);
          // An awaited readiness promise may have been invalidated before this continuation.
          if (opts.signal?.aborted) throw channelError("conflict", "Request canceled");
          if (now() >= deadline)
            throw channelError("timeout", "Coordinator communication timed out");
          initialNative ??= c.nativeSessionId;
          if (syncNative() !== initialNative)
            throw channelError("conflict", "Native session changed");
          if (configuration !== c || !connected || !c.coordinatorConnected) continue;
          if (opts.bindingId !== undefined && c.bindingId !== opts.bindingId)
            throw channelError("conflict", "Bridge binding changed during tool authorization");
          const requestId = randomUUID();
          const result = new Promise<any>((resolve) =>
            pending.set(requestId, { bindingId: c.bindingId, resolve }),
          );
          const sent = options.send({
            type: "agent.request",
            requestId,
            sessionId: c.sessionId,
            nativeSessionId: c.nativeSessionId,
            runtimeId,
            bindingId: c.bindingId,
            context: contextIds(),
            ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
            deadlineAt,
            method,
            args,
          });
          if (!sent) {
            pending.delete(requestId);
            connected = false;
            wake();
            continue;
          }
          let response: any;
          const cancelWait = new AbortController();
          const waitSignal = opts.signal
            ? AbortSignal.any([opts.signal, cancelWait.signal])
            : cancelWait.signal;
          try {
            response = await Promise.race([result, delay(deadline, waitSignal).then(() => null)]);
          } finally {
            cancelWait.abort();
            pending.delete(requestId);
          }
          assertBinding(binding);
          if (!response) continue;
          if (binding && (!configuration || !connected || !configuration.coordinatorConnected))
            continue;
          if (response.ok) return response.result;
          if (response.error?.code === "host_unreachable" || response.error?.code === "timeout") {
            const retryAt = Math.min(deadline, now() + 100);
            try {
              await delay(retryAt, opts.signal);
            } catch (error: any) {
              if (error.code !== "timeout" || now() >= deadline) throw error;
            }
            assertBinding(binding);
            continue;
          }
          throw channelError(
            response.error?.code ?? "internal",
            response.error?.message ?? "Agent request failed",
            response.error?.details,
          );
        }
      } finally {
        activeRequests--;
      }
    },
    registerCommand(method, handler) {
      if (handlers.has(method)) throw new Error(`Duplicate bridge handler: ${method}`);
      handlers.set(method, handler);
      return () => {
        if (handlers.get(method) === handler) handlers.delete(method);
      };
    },
    noteHumanInput,
    close() {
      if (closed) return;
      closed = true;
      invalidate();
    },
  };
  return channel;
}
