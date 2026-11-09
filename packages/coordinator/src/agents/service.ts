import { createHash } from "node:crypto";
import {
  AGENT_FRAME_MAX_BYTES,
  type AgentInbox,
  type AgentMessage,
  AgentReceiptPeekRequest,
  AgentRequestFrame,
  type AgentResultFrame,
  type AgentToolPolicyWait,
  CreateAgentTask,
  type ErrorBody,
  HostPolicyBoundary,
  HostToolPolicyContext,
  PolicyEvaluation,
  ReadAgentInbox,
  SendAgentMessage,
  type Session,
  SwitchyardError,
  titleFrom,
} from "@switchyard/protocol";
import { z } from "zod";
import { parse } from "../http.js";
import type { PolicyOwner } from "../policies/contracts.js";
import { LIVE_RUNTIMES } from "../sessions/service.js";
import type { Store } from "../store.js";
import { createTask } from "../tasks/service.js";

type ToolMethod = "task.create" | "message.send" | "inbox.read";
type StoredResult = { ok: true; result: unknown } | { ok: false; error: ErrorBody };

/** All methods are synchronous and join the AgentService receipt transaction. */
export interface AgentMessages {
  /** Validate/persist trusted human and causal IDs; never accept model-supplied ancestry. */
  recordContext(sessionId: string, context: AgentRequestFrame["context"]): void;
  send(callerSessionId: string, args: SendAgentMessage): AgentMessage;
  /** Enforce the 120 KiB page limit and mark returned rows read atomically. */
  readInbox(callerSessionId: string, args: ReadAgentInbox): AgentInbox;
  /** Wake delivery only; must not wait for the recipient or launch/resume it. */
  wake(): void;
}

/** Broker-only A.1 input. Identity is supplied by the authenticated frame, not args. */
const BindingArgs = z
  .object({
    version: z.literal(1),
    sessionFile: z.string().min(1).nullable(),
    mode: z.enum(["rpc", "terminal"]),
    capabilities: z
      .object({
        agentTools: z.boolean(),
        messageDelivery: z.boolean(),
        editorDraftGuard: z.boolean(),
        toolPolicy: z.boolean(),
      })
      .strict(),
    policyRequired: z.boolean(),
    // Legacy unprotected hosts remain readable; protected bindings must supply this proof.
    controllerEpoch: z.string().min(1).max(200).optional(),
    policyBoundary: HostPolicyBoundary.optional(),
  })
  .strict();

type BoundBridge = NonNullable<Session["bridge"]> & { nativeSessionId: string };

export interface AgentCallContext {
  caller: Session;
  target: Session | null;
  controlMode: "human" | "automation";
  controlRevision: number;
  targetControlMode: "human" | "automation" | null;
  targetControlRevision: number | null;
}

export interface AgentServiceOptions {
  store: Store;
  messages?: AgentMessages;
  scheduleDispatch(): void;
  /** Current authenticated host/welcome intersection; absent means legacy/unsupported. */
  negotiatedFeatures?: (hostId: string) => ReadonlySet<string>;
  /** Current launch scope/limits may strengthen, never weaken, the host's required latch. */
  launchRequirement?: (caller: Session) => { required: boolean };
  publicUrl?: () => string;
  /** Synchronous trusted-host attestation; joins the broker bind transaction. */
  bindPolicyBoundary?: (owner: PolicyOwner, boundary: HostPolicyBoundary) => void;
  /** Cancel decisions for an obsolete binding, including on a native branch switch. */
  onUnbind?: (sessionId: string, runtimeId: string) => void;
  /** Immediate verdict only: ASK never suspends a mutation or completes a tool receipt. */
  authorize?: (context: AgentCallContext, frame: AgentRequestFrame) => Promise<PolicyEvaluation>;
  /** Read-only final ALLOW/freshness fence; runs synchronously in the action savepoint. */
  assertAuthorization?: (context: AgentCallContext, frame: AgentRequestFrame) => void;
  /** Must enforce decision ownership by caller/native/runtime for status and cancel. */
  policyRequest?: (
    context: AgentCallContext,
    frame: AgentRequestFrame,
    hostPolicyContext?: HostToolPolicyContext,
  ) => Promise<unknown>;
}

const TOOL_METHODS = new Set<string>(["task.create", "message.send", "inbox.read"]);
const TRANSIENT_ERRORS = new Set([
  "internal",
  "timeout",
  "host_unreachable",
  "rate_limited",
  "stale_control",
]);

/** Canonical JSON: argument object key order is not part of an invocation's identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function errorOf(error: unknown): SwitchyardError {
  if (error instanceof SwitchyardError) return error;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new SwitchyardError("timeout", "Agent request was canceled or timed out");
  }
  return new SwitchyardError("internal", "Agent request failed");
}

/** Authenticated host-only entry point. This is deliberately not a device/API endpoint. */
export class AgentService {
  private readonly bindings = new Map<
    string,
    {
      nativeSessionId: string;
      runtimeId: string;
      controllerEpoch?: string;
      agentTools: boolean;
    }
  >();
  private readonly store: Store;

  constructor(private readonly options: AgentServiceOptions) {
    this.store = options.store;
  }

  async handle(
    authenticatedHostId: string,
    input: AgentRequestFrame,
    hostPolicyContext?: HostToolPolicyContext,
  ): Promise<AgentResultFrame> {
    const receivedAt = this.store.now().getTime();
    const envelope = {
      type: "agent.result" as const,
      requestId: input.requestId,
      runtimeId: input.runtimeId,
    };
    try {
      // Measure the original JSON, before Zod strips any unknown keys.
      const json = JSON.stringify(input);
      if (Buffer.byteLength(json) > AGENT_FRAME_MAX_BYTES) {
        throw new SwitchyardError("invalid_request", "Agent request exceeds 128 KiB");
      }
      const frame = parse(AgentRequestFrame, JSON.parse(json));
      if (frame.receiptReplay !== undefined && !TOOL_METHODS.has(frame.method)) {
        throw new SwitchyardError("invalid_request", "Receipt replay is restricted to agent tools");
      }
      if ((frame.method === "policy.evaluate") !== (hostPolicyContext !== undefined)) {
        throw new SwitchyardError(
          "forbidden",
          "Host policy context is required only for policy.evaluate",
        );
      }
      const trustedContext =
        hostPolicyContext === undefined
          ? undefined
          : parse(HostToolPolicyContext, hostPolicyContext);
      // Count the enriched wire envelope too; only parsed values enter this object.
      if (
        trustedContext !== undefined &&
        Buffer.byteLength(JSON.stringify({ ...frame, policyContext: trustedContext })) >
          AGENT_FRAME_MAX_BYTES
      ) {
        throw new SwitchyardError("invalid_request", "Agent request exceeds 128 KiB");
      }
      const caller = this.ownedCaller(authenticatedHostId, frame.sessionId);
      if (frame.method === "session.bind") {
        return { ...envelope, ok: true, result: this.store.tx(() => this.bind(caller, frame)) };
      }
      this.boundCaller(caller, frame);
      if (!TOOL_METHODS.has(frame.method) && frame.method !== "receipt.peek") {
        if (!this.options.negotiatedFeatures?.(authenticatedHostId).has("policies.v1")) {
          throw new SwitchyardError("unsupported_capability", "Agent policies were not negotiated");
        }
        const context = this.callContext(caller, null);
        if (!this.options.policyRequest) {
          throw new SwitchyardError("unsupported_capability", "Agent policies are not installed");
        }
        return {
          ...envelope,
          ok: true,
          result: await this.options.policyRequest(context, frame, trustedContext),
        };
      }
      if (!this.bindings.get(caller.id)?.agentTools) {
        throw new SwitchyardError("unsupported_capability", "Bridge agent tools are unavailable");
      }
      if (!frame.toolCallId) {
        throw new SwitchyardError("invalid_request", "Agent tools require toolCallId");
      }
      if (frame.method === "receipt.peek") {
        const peek = parse(AgentReceiptPeekRequest, frame.args);
        const { hash } = this.normalizedArguments(peek.method, peek.args);
        const receipt = this.receipt({ ...frame, method: peek.method }, hash);
        return {
          ...envelope,
          ok: true,
          result: receipt ? { found: true, requestHash: hash } : { found: false },
        };
      }
      if (frame.deadlineAt === undefined) {
        throw new SwitchyardError("invalid_request", "Agent tools require deadlineAt");
      }
      // This request's budget is fixed at ingress, including across an authorization await.
      const deadline = Math.min(Date.parse(frame.deadlineAt), receivedAt + 30_000);
      const method = frame.method as ToolMethod;
      const { args, argumentError, hash } = this.normalizedArguments(method, frame.args);
      if (frame.receiptReplay !== undefined) {
        // This marker can only narrow access to a past result, never authorize new work.
        if (frame.receiptReplay.requestHash !== hash) this.unavailableReceipt();
        const recorded = this.receipt(frame, hash, true);
        if (!recorded) this.unavailableReceipt();
        return { ...envelope, ...recorded };
      }
      const replay = this.receipt(frame, hash);
      if (replay) return { ...envelope, ...replay };
      this.assertDeadline(deadline);
      if (argumentError) {
        return {
          ...envelope,
          ...this.finish(frame, hash, deadline, () => {
            throw argumentError;
          }),
        };
      }
      const normalizedFrame = { ...frame, args };
      let authorizedKey: string;
      try {
        const context = this.callContext(caller, this.target(method, caller, args));
        authorizedKey = this.contextKey(context);
        if (this.options.authorize) {
          const evaluation = parse(
            PolicyEvaluation,
            await this.options.authorize(context, normalizedFrame),
          );
          this.assertDeadline(deadline);
          if (evaluation.verdict === "DENY") {
            throw new SwitchyardError("forbidden", evaluation.reason);
          }
          if (evaluation.verdict === "ASK") {
            const wait: AgentToolPolicyWait = {
              type: "policy.required",
              decisionId: evaluation.decisionId,
              interactionId: evaluation.interactionId,
              interactionUrl: evaluation.interactionUrl,
            };
            return { ...envelope, ok: true, result: wait };
          }
        }
      } catch (error) {
        return {
          ...envelope,
          ...this.finish(frame, hash, deadline, () => {
            throw error;
          }),
        };
      }
      return {
        ...envelope,
        ...this.finish(frame, hash, deadline, () => {
          // Never hold SQLite open during authorization. Revalidate after await.
          const current = this.ownedCaller(authenticatedHostId, frame.sessionId);
          this.boundCaller(current, frame);
          const next = this.callContext(current, this.target(method, current, args));
          if (authorizedKey !== this.contextKey(next)) {
            throw new SwitchyardError(
              "stale_control",
              "Agent request context changed; retry authorization",
            );
          }
          this.options.assertAuthorization?.(next, normalizedFrame);
          this.options.messages?.recordContext(current.id, frame.context);
          return this.execute(method, current, frame.toolCallId!, args);
        }),
      };
    } catch (error) {
      return { ...envelope, ok: false, error: errorOf(error).toBody() };
    }
  }

  private ownedCaller(hostId: string, sessionId: string): Session {
    const host = this.store.hosts.require(hostId);
    if (host.revokedAt) throw new SwitchyardError("forbidden", "Host has been revoked");
    const caller = this.store.sessions.require(sessionId);
    if (caller.hostId !== hostId)
      throw new SwitchyardError("forbidden", "Session belongs to another host");
    if (caller.readOnly || caller.archivedAt) {
      throw new SwitchyardError("forbidden", "Agent tools require a writable, nonarchived session");
    }
    if (!LIVE_RUNTIMES.includes(caller.runtime)) {
      throw new SwitchyardError("conflict", "Agent caller is not live");
    }
    return caller;
  }

  private bind(caller: Session, frame: AgentRequestFrame): unknown {
    if (frame.toolCallId) {
      throw new SwitchyardError(
        "invalid_request",
        "Session binding is broker-only, not an agent tool",
      );
    }
    const args = parse(BindingArgs, frame.args);
    const negotiated = this.options.negotiatedFeatures?.(caller.hostId) ?? new Set<string>();
    if (!negotiated.has("agentRequests.v1")) {
      throw new SwitchyardError("unsupported_capability", "Agent requests were not negotiated");
    }
    const capabilities = args.capabilities;
    const host = this.store.hosts.require(caller.hostId);
    const currentRequirement = this.options.launchRequirement?.(caller);
    const policyRequired = args.policyRequired || (currentRequirement?.required ?? false);
    const policyEnabled =
      negotiated.has("policies.v1") &&
      host.capabilities?.agentRequests === true &&
      host.capabilities.policies === true &&
      capabilities.toolPolicy &&
      args.policyBoundary !== undefined &&
      this.options.bindPolicyBoundary !== undefined;
    if (policyRequired && !policyEnabled)
      throw new SwitchyardError(
        "unsupported_capability",
        "Required policy enforcement is unavailable.",
      );
    if (
      (policyEnabled || policyRequired || caller.bridge?.controllerEpoch) &&
      !args.controllerEpoch
    )
      throw new SwitchyardError(
        "invalid_request",
        "Protected session binding requires a host controller epoch.",
      );
    if (policyEnabled) {
      this.options.bindPolicyBoundary!(
        {
          authenticatedHostId: caller.hostId,
          sessionId: caller.id,
          nativeSessionId: frame.nativeSessionId,
          runtimeId: frame.runtimeId,
        },
        args.policyBoundary!,
      );
    }
    const features =
      policyEnabled ||
      capabilities.agentTools ||
      (capabilities.messageDelivery && capabilities.editorDraftGuard)
        ? ["agentRequests.v1"]
        : [];
    if (policyEnabled) features.push("policies.v1");
    const bridge: BoundBridge = {
      version: 1,
      runtimeId: frame.runtimeId,
      nativeSessionId: frame.nativeSessionId,
      ...(args.controllerEpoch === undefined ? {} : { controllerEpoch: args.controllerEpoch }),
      agentTools: false,
      messageDelivery: false,
      policyState: "initializing",
      policyPhases: [],
    };
    // A missing file is not a missing native identity. Never retain another native session's file.
    const nativeHandle =
      args.sessionFile !== null
        ? { sessionId: frame.nativeSessionId, sessionFile: args.sessionFile }
        : caller.nativeHandle?.sessionId === frame.nativeSessionId
          ? caller.nativeHandle
          : null;
    this.options.messages?.recordContext(caller.id, frame.context);
    const previous = this.bindings.get(caller.id);
    const obsolete =
      previous ??
      (caller.bridge
        ? {
            runtimeId: caller.bridge.runtimeId,
            nativeSessionId: (caller.bridge as BoundBridge).nativeSessionId,
            controllerEpoch: caller.bridge.controllerEpoch,
          }
        : undefined);
    if (
      obsolete &&
      (obsolete.runtimeId !== frame.runtimeId ||
        obsolete.nativeSessionId !== frame.nativeSessionId ||
        obsolete.controllerEpoch !== args.controllerEpoch)
    ) {
      this.store.afterCommit(() => this.options.onUnbind?.(caller.id, obsolete.runtimeId));
    }
    // The host must still configure the bridge and await its receipt before reporting active.
    this.store.putSession({
      ...caller,
      nativeHandle,
      bridge,
    });
    this.bindings.set(caller.id, {
      nativeSessionId: frame.nativeSessionId,
      runtimeId: frame.runtimeId,
      controllerEpoch: args.controllerEpoch,
      agentTools: capabilities.agentTools,
    });
    return {
      version: 1,
      sessionId: caller.id,
      runtimeId: frame.runtimeId,
      nativeSessionId: frame.nativeSessionId,
      features,
      policyRequired,
      sessionUrl:
        policyEnabled && this.options.publicUrl
          ? `${this.options.publicUrl().replace(/\/+$/, "")}/code/${encodeURIComponent(caller.id)}`
          : null,
    };
  }

  private boundCaller(caller: Session, frame: AgentRequestFrame): void {
    const binding = this.bindings.get(caller.id);
    if (
      !binding ||
      binding.nativeSessionId !== frame.nativeSessionId ||
      binding.runtimeId !== frame.runtimeId ||
      binding.controllerEpoch !== caller.bridge?.controllerEpoch ||
      (caller.bridge as BoundBridge | undefined)?.nativeSessionId !== frame.nativeSessionId ||
      (caller.nativeHandle !== null && caller.nativeHandle.sessionId !== frame.nativeSessionId) ||
      caller.bridge?.runtimeId !== frame.runtimeId
    ) {
      throw new SwitchyardError(
        "stale_control",
        "Agent session binding is missing or obsolete; bind again",
      );
    }
  }

  private arguments(method: ToolMethod, args: unknown): unknown {
    switch (method) {
      case "task.create":
        return parse(CreateAgentTask, args);
      case "message.send":
        return parse(SendAgentMessage, args);
      case "inbox.read":
        return parse(ReadAgentInbox, args);
    }
  }

  /** Keep defaults and permanent validation-error identity identical for all receipt paths. */
  private normalizedArguments(method: ToolMethod, input: unknown) {
    let args = input;
    let argumentError: SwitchyardError | undefined;
    try {
      args = this.arguments(method, input);
    } catch (error) {
      argumentError = errorOf(error);
    }
    return {
      args,
      argumentError,
      hash: createHash("sha256").update(canonical(args)).digest("hex"),
    };
  }

  private target(method: ToolMethod, caller: Session, args: unknown): Session | null {
    if (method !== "message.send") return null;
    const { sessionId } = args as SendAgentMessage;
    if (sessionId === caller.id) {
      throw new SwitchyardError(
        "invalid_request",
        "Use your current session directly instead of sending to yourself.",
      );
    }
    const target = this.store.sessions.require(sessionId);
    if (!caller.projectId || target.projectId !== caller.projectId) {
      throw new SwitchyardError(
        "invalid_request",
        "Agent messages require sessions in the same project",
      );
    }
    if (
      target.readOnly ||
      target.archivedAt ||
      (!LIVE_RUNTIMES.includes(target.runtime) && !target.nativeHandle)
    ) {
      throw new SwitchyardError(
        "invalid_request",
        "Message target must be writable, nonarchived and live or resumable",
      );
    }
    return target;
  }

  private callContext(caller: Session, target: Session | null): AgentCallContext {
    const run = this.store.runForSession(caller);
    const targetRun = target ? this.store.runForSession(target) : undefined;
    return {
      caller,
      target,
      controlMode: run?.controlMode ?? "human",
      controlRevision: run?.controlRevision ?? 1,
      targetControlMode: target ? (targetRun?.controlMode ?? "human") : null,
      targetControlRevision: target ? (targetRun?.controlRevision ?? 1) : null,
    };
  }

  private contextKey(context: AgentCallContext): string {
    const identity = (session: Session | null) =>
      session && [
        session.id,
        session.hostId,
        session.projectId,
        session.taskId,
        session.runId,
        this.store.runForSession(session)?.id ?? null,
        session.cwd,
        // The bridge owns actor identity; file discovery/path changes are only metadata.
        session.bridge?.nativeSessionId ?? null,
        session.bridge?.runtimeId ?? null,
        session.bridge?.controllerEpoch ?? null,
        session.profileSnapshot,
        session.taskId ? (this.store.tasks.get(session.taskId)?.parentTaskId ?? null) : null,
      ];
    return canonical([
      identity(context.caller),
      identity(context.target),
      context.controlMode,
      context.controlRevision,
      context.targetControlMode,
      context.targetControlRevision,
    ]);
  }

  private unavailableReceipt(): never {
    throw new SwitchyardError(
      "conflict",
      "The recorded tool result is no longer available; no action was executed.",
    );
  }

  private receipt(
    frame: AgentRequestFrame,
    hash: string,
    replayOnly = false,
  ): StoredResult | undefined {
    const row = this.store.st
      .get(`SELECT request_hash, result_json FROM agent_call_receipts
      WHERE caller_session_id = ? AND native_session_id = ? AND tool_call_id = ? AND method = ?`)
      .get(frame.sessionId, frame.nativeSessionId, frame.toolCallId!, frame.method) as
      | { request_hash: string; result_json: string }
      | undefined;
    if (!row) {
      if (replayOnly) this.unavailableReceipt();
      return undefined;
    }
    if (row.request_hash !== hash) {
      if (replayOnly) this.unavailableReceipt();
      throw new SwitchyardError(
        "conflict",
        "Agent call identity was reused with different arguments",
      );
    }
    return JSON.parse(row.result_json) as StoredResult;
  }

  private assertDeadline(deadline: number): void {
    if (!Number.isFinite(deadline) || this.store.now().getTime() >= deadline) {
      throw new SwitchyardError("timeout", "Agent request deadline expired");
    }
  }

  private finish(
    frame: AgentRequestFrame,
    hash: string,
    deadline: number,
    action: () => unknown,
  ): StoredResult {
    return this.store.tx(() => {
      const replay = this.receipt(frame, hash);
      if (replay) return replay;
      const attempt = this.store.savepoint(() => {
        this.assertDeadline(deadline);
        return action();
      });
      let result: StoredResult;
      if (attempt.ok) result = { ok: true, result: attempt.value };
      else {
        const error = errorOf(attempt.error);
        result = { ok: false, error: error.toBody() };
        if (TRANSIENT_ERRORS.has(error.code)) return result;
      }
      this.store.st
        .get(`INSERT INTO agent_call_receipts
        (caller_session_id, native_session_id, tool_call_id, method, request_hash, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          frame.sessionId,
          frame.nativeSessionId,
          frame.toolCallId!,
          frame.method,
          hash,
          JSON.stringify(result),
          this.store.nowIso(),
        );
      return result;
    });
  }

  private execute(method: ToolMethod, caller: Session, toolCallId: string, args: unknown): unknown {
    if (method === "task.create") {
      if (!caller.projectId) {
        throw new SwitchyardError(
          "invalid_request",
          "Start this session in a project before creating a task.",
        );
      }
      const input = args as CreateAgentTask;
      const parentTaskId = input.parentTaskId === undefined ? caller.taskId : input.parentTaskId;
      const task = createTask(
        { store: this.store },
        {
          projectId: caller.projectId,
          title: titleFrom(input.objective),
          objective: input.objective,
          acceptanceCriteria: input.acceptance,
          dependencies: input.dependencies,
          parentTaskId,
          state: "ready",
          policy: { hostId: input.hostId, profileId: input.profileId },
        },
        { kind: "manual" },
        { sessionId: caller.id, toolCallId },
      );
      if (input.notifyOnFinish) {
        this.store.st
          .get(`INSERT INTO task_subscriptions
          (child_task_id, subscriber_session_id, parent_task_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(task.id, caller.id, parentTaskId, this.store.nowIso());
      }
      this.store.afterCommit(() => this.options.scheduleDispatch());
      return { task };
    }
    if (!this.options.messages) {
      throw new SwitchyardError("unsupported_capability", "Agent messages are not installed");
    }
    if (method === "inbox.read")
      return this.options.messages.readInbox(caller.id, args as ReadAgentInbox);
    const message = this.options.messages.send(caller.id, args as SendAgentMessage);
    this.store.afterCommit(() => this.options.messages!.wake());
    return { message };
  }
}
