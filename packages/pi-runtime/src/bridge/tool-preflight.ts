import { type AgentBindingIdentity, type AgentChannel, channelError } from "./agent-channel.js";

export type AgentToolMethod = "task.create" | "message.send" | "inbox.read";
export type AgentToolPreflight = {
  method: AgentToolMethod;
  toolCallId: string;
  binding: AgentBindingIdentity;
} & ({ mode: "normal" } | { mode: "receipt"; requestHash: string });
export type AgentToolPreflightOwner = {
  readonly method: AgentToolMethod;
  readonly toolCallId: string;
  readonly token: symbol;
};
export type AgentToolPreflightClaim = {
  owner: AgentToolPreflightOwner;
  preflight: AgentToolPreflight;
};
export class DuplicateAgentToolPreflightError extends Error {
  constructor() {
    super("Tool preflight is already active");
    this.name = "DuplicateAgentToolPreflightError";
  }
}
type Invocation = {
  owner: AgentToolPreflightOwner;
  phase: "checking" | "armed" | "executing";
  preflight: AgentToolPreflight | null;
  readonly args: string;
  readonly binding: AgentBindingIdentity | null;
  cleanup(): void;
};
type State = {
  methods: Map<string, AgentToolMethod>;
  invocations: Map<string, Invocation>;
  protected: boolean;
};
const states = new WeakMap<AgentChannel, State>();
const key = (method: AgentToolMethod, toolCallId: string) => JSON.stringify([method, toolCallId]);
function state(channel: AgentChannel): State {
  let value = states.get(channel);
  if (!value) {
    value = { methods: new Map(), invocations: new Map(), protected: false };
    states.set(channel, value);
  }
  return value;
}

/** Register only names belonging to the actual Switchyard tool adapters. */
export function registerAgentToolMethod(
  channel: AgentChannel,
  name: string,
  method: AgentToolMethod,
): void {
  state(channel).methods.set(name, method);
}
export function agentToolMethod(channel: AgentChannel, name: string): AgentToolMethod | undefined {
  return state(channel).methods.get(name);
}
export function requireAgentToolPreflight(channel: AgentChannel): void {
  state(channel).protected = true;
}
export function agentToolPreflightRequired(channel: AgentChannel): boolean {
  const current = channel.snapshot();
  return (
    state(channel).protected ||
    current.policyRequired ||
    current.policyState === "active" ||
    current.policyState === "lost"
  );
}

// A detached canonical JSON action, never a freeze of Pi's shared mutable event.input.
type Json = null | string | boolean | number | Json[] | { [key: string]: Json };
function cloneJson(value: unknown, ancestors = new Set<object>(), depth = 0): Json {
  if (depth > 20) throw new Error("Policy tool input is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  if (typeof value !== "object" || value === null || ancestors.has(value))
    throw new Error("Policy tool input must be JSON.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error("Policy tool input must be a plain JSON object.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (v) => cloneJson(v, ancestors, depth + 1));
    const result: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) {
      if (k === "__proto__" || k === "constructor" || k === "prototype")
        throw new Error("Policy tool input contains a forbidden key.");
      result[k] = cloneJson((value as Record<string, unknown>)[k], ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
export function toolArgs(input: unknown): Record<string, Json> {
  const args = cloneJson(input);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Policy tool input must be a JSON object.");
  return args;
}

function sameBinding(a: AgentBindingIdentity, b: AgentBindingIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.runtimeId === b.runtimeId &&
    a.nativeSessionId === b.nativeSessionId &&
    a.bindingId === b.bindingId
  );
}

/** Reserve before awaiting lookup/approval; active records are never evicted or overwritten. */
export function beginAgentToolPreflight(
  channel: AgentChannel,
  method: AgentToolMethod,
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
): AgentToolPreflightOwner {
  const invocations = state(channel).invocations;
  const id = key(method, toolCallId);
  if (invocations.has(id)) throw new DuplicateAgentToolPreflightError();
  if (signal?.aborted) throw channelError("conflict", "Policy approval canceled");
  if (invocations.size >= 64) throw channelError("rate_limited", "Too many active tool preflights");
  const immutableArgs = JSON.stringify(toolArgs(args));
  const configuration = channel.snapshot().configuration;
  const owner = Object.freeze({ method, toolCallId, token: Symbol("tool-preflight") });
  const abort = () => releaseAgentToolPreflight(channel, owner);
  invocations.set(id, {
    owner,
    phase: "checking",
    preflight: null,
    args: immutableArgs,
    binding: configuration ? Object.freeze({ ...configuration }) : null,
    cleanup: () => signal?.removeEventListener("abort", abort),
  });
  signal?.addEventListener("abort", abort, { once: true });
  return owner;
}
export function rememberAgentToolPreflight(
  channel: AgentChannel,
  owner: AgentToolPreflightOwner,
  preflight: AgentToolPreflight,
): void {
  const invocation = state(channel).invocations.get(key(owner.method, owner.toolCallId));
  if (invocation?.owner.token !== owner.token || invocation.phase !== "checking")
    throw channelError("conflict", "Tool preflight is missing or already finalized");
  const current = channel.snapshot().configuration;
  if (
    preflight.method !== owner.method ||
    preflight.toolCallId !== owner.toolCallId ||
    !current ||
    !sameBinding(current, preflight.binding) ||
    (invocation.binding && !sameBinding(invocation.binding, preflight.binding))
  )
    throw channelError("conflict", "Tool action does not match its preflight binding");
  if (preflight.mode === "receipt" && !/^[a-f0-9]{64}$/.test(preflight.requestHash))
    throw channelError("invalid_request", "Invalid recorded tool result hash");
  invocation.preflight = Object.freeze({
    ...preflight,
    binding: Object.freeze({ ...preflight.binding }),
  });
  invocation.phase = "armed";
}
export function consumeAgentToolPreflight(
  channel: AgentChannel,
  method: AgentToolMethod,
  toolCallId: string,
  args: unknown,
): AgentToolPreflightClaim | undefined {
  const invocation = state(channel).invocations.get(key(method, toolCallId));
  if (!invocation) return undefined;
  // Checking, executing and mismatched records stay restrictive, including across rebinding.
  if (
    invocation.phase !== "armed" ||
    !invocation.preflight ||
    invocation.args !== JSON.stringify(toolArgs(args))
  )
    throw channelError("conflict", "Tool action does not match its completed preflight");
  invocation.phase = "executing";
  return { owner: invocation.owner, preflight: invocation.preflight };
}
export function releaseAgentToolPreflight(
  channel: AgentChannel,
  owner: AgentToolPreflightOwner,
): boolean {
  const invocations = state(channel).invocations;
  const id = key(owner.method, owner.toolCallId);
  const invocation = invocations.get(id);
  if (invocation?.owner.token !== owner.token) return false;
  invocations.delete(id);
  invocation.cleanup();
  return true;
}

/** Only call at a proven final-idle boundary, never for an ambiguous tool_execution_end. */
export function sweepUnclaimedAgentToolPreflights(channel: AgentChannel): void {
  for (const invocation of [...state(channel).invocations.values()]) {
    if (invocation.phase !== "executing") releaseAgentToolPreflight(channel, invocation.owner);
  }
}

/** Genuine teardown is scoped to this channel, not another extension/runtime. */
export function clearAgentToolPreflights(channel: AgentChannel): void {
  for (const { owner } of [...state(channel).invocations.values()])
    releaseAgentToolPreflight(channel, owner);
}
