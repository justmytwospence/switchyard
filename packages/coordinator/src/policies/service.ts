import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  type AnswerResult,
  CompletedUsageWatermark,
  CreateAgentTask,
  CreatePolicyRuleRequest,
  canonicalPolicyJson,
  HostPolicyBoundary,
  type HostPolicySampleRequest,
  HostPolicySampleResult,
  HostToolPolicyContext,
  type Interaction,
  newId,
  POLICY_CAPABILITY_EXPLANATION,
  PolicyCancelRequest,
  type PolicyCancelResult,
  PolicyContext,
  PolicyCounterMap,
  PolicyEvaluateRequest,
  type PolicyEvaluation,
  type PolicyGrant,
  PolicyRule,
  PolicySettings,
  PolicyStatusRequest,
  type PolicyStatusResult,
  PolicyTestRequest,
  type PolicyTestResult,
  type PolicyTrace,
  ReadAgentInbox,
  type Run,
  SendAgentMessage,
  type Session,
  SwitchyardError,
  type Task,
  UpdatePolicyRuleRequest,
  UpdatePolicySettingsRequest,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import type { Store } from "../store.js";
import {
  CONTINUATION_PREFIX,
  type ContinuationAuthorization,
  type ContinuationSource,
  continuationContext,
  continuationSource,
  type PendingContinuation,
} from "../tasks/continuations.js";
import {
  BUDGET_ACCOUNTING_UNAVAILABLE,
  builtinPolicyRules,
  CONTINUATION_SOFT_BUDGET_EXPRESSION,
} from "./builtins.js";
import type {
  EvaluatedRule,
  PolicyAuthorizeInput,
  PolicyOwner,
  PolicyRootStamp,
  ReservedContinuationReadiness,
  Validation,
} from "./contracts.js";
import { PolicyEvaluator } from "./evaluator.js";
import {
  POLICY_LAUNCH_UNAVAILABLE,
  type PolicyLaunchInput,
  type PolicyLaunchRequirement,
  policyLaunchRequirement,
} from "./launch.js";

/** Injectable evaluator for isolated service tests; production uses the bounded worker pool. */
export interface PolicyServiceOptions {
  store: Store;
  publicUrl: string;
  reconcileInputAttention(interaction: Interaction): void;
  /** Current authenticated socket/welcome, never cached Host connectivity or capabilities. */
  hostPolicyConnection?: (hostId: string) => {
    connected: boolean;
    features: ReadonlySet<string>;
  };
  classifySample?: (
    request: HostPolicySampleRequest,
    options: { signal?: AbortSignal },
  ) => Promise<HostPolicySampleResult>;
  evaluator?: {
    validateRule(rule: PolicyRule): Promise<Validation>;
    evaluateRules(
      rules: PolicyRule[],
      context: Omit<PolicyContext, "counters">,
      countersByRule: Record<string, PolicyCounterMap>,
    ): Promise<EvaluatedRule[]>;
    close?(): Promise<void>;
  };
}

type Scope = PolicyGrant["scope"];
type Counter = { values: PolicyCounterMap; version: number };
type Snapshot = {
  key: string;
  hash: string;
  owner: PolicyOwner | null;
  scope: Scope;
  context: Omit<PolicyContext, "counters">;
  rules: PolicyRule[];
  counters: Record<string, Counter>;
  revisions: string;
  rootStamp: PolicyRootStamp | null;
  accountingBlocked: boolean;
};
type EvaluationRow = {
  evaluation_key: string;
  request_hash: string;
  scope_kind: Scope["kind"];
  scope_id: string;
  session_id: string;
  revisions_json: string;
  input_json: string;
  provisional_updates_json: string;
  verdict: PolicyEvaluation["verdict"];
  decision_id: string;
  interaction_id: string | null;
  result_json: string;
  canceled: number;
  cancellation_reason: string | null;
  wait_lease_until: string | null;
};
type RuleRow = {
  id: string;
  scope: PolicyRule["scope"];
  scope_id: string | null;
  priority: number;
  revision: number;
  enabled: number;
  phases: string;
  name: string;
  expression: string;
  built_in: number;
  created_at: string;
  updated_at: string;
};
const unavailable = "Policy evaluation is unavailable; the action was blocked.";
const stale = "The policy authorization context changed. Retry the action.";
const rootEnded = "The root task has ended; reopen it before starting more agent work.";
const leaseExpired = "The policy approval wait expired. Retry the action.";
const waitLeaseMs = 60_000;
const testUnsupported = "Select a session with policy support to test this rule.";

/** Stop read-only waits even when an injected host/evaluator does not observe cancellation. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const emptySafety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [] as string[],
};
const hash = (value: Parameters<typeof canonicalPolicyJson>[0]) =>
  createHash("sha256").update(canonicalPolicyJson(value)).digest("hex");
const json = (value: unknown) =>
  canonicalPolicyJson(value as Parameters<typeof canonicalPolicyJson>[0]);
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const positive = (n: number) => Number.isSafeInteger(n) && n >= 1;
const softBudget = (rule: PolicyRule) =>
  rule.builtIn &&
  rule.id === "continuation-soft-budget" &&
  rule.expression === CONTINUATION_SOFT_BUDGET_EXPRESSION;

function fromRow(r: RuleRow): PolicyRule {
  return PolicyRule.parse({
    id: r.id,
    scope: r.scope,
    scopeId: r.scope_id,
    priority: r.priority,
    revision: r.revision,
    enabled: !!r.enabled,
    phases: JSON.parse(r.phases),
    name: r.name,
    expression: r.expression,
    builtIn: !!r.built_in,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

/** Coordinator-owned authorization. No supplied context can replace stored identity/control. */
export class PolicyService {
  private readonly store: Store;
  private readonly evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
  private readonly options: PolicyServiceOptions;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private leaseSweeper: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private initialized = false;
  private initialization: Promise<void> | null = null;

  get ready(): boolean {
    return this.initialized;
  }

  /** Bootstrap the real evaluator without trusting or overwriting owner-edited built-ins. */
  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (!this.options.evaluator && !this.options.hostPolicyConnection)
        throw new SwitchyardError("internal", "Policy host connection callback is required.");
      this.start();
      const factory = builtinPolicyRules(this.store.nowIso()).find(
        (r) => r.id === "destructive-shell",
      )!;
      const result = await this.evaluator.validateRule(factory);
      if (!result.valid)
        throw new SwitchyardError(
          "internal",
          `Policy evaluator initialization failed: ${result.error.message}`,
        );
      if (!this.started)
        throw new SwitchyardError(
          "host_unreachable",
          "Policy service stopped during initialization.",
        );
      this.initialized = true;
    })();
    return this.initialization;
  }

  launchRequirement(input: PolicyLaunchInput): PolicyLaunchRequirement {
    if (!this.ready)
      throw new SwitchyardError("unsupported_capability", "Policy service is not initialized.");
    return policyLaunchRequirement(input, this.listRules(), this.settings().revision);
  }
  private readonly taskParents = new Map<string, string | null>();
  private readonly taskRoots = new Map<string, string>();
  private readonly taskLimits = new Map<string, string>();
  private readonly runLimits = new Map<string, string>();

  constructor(options: PolicyServiceOptions | CoordinatorContext) {
    this.options =
      "config" in options
        ? {
            store: options.store,
            publicUrl: options.config.publicUrl,
            reconcileInputAttention: (i) => options.hostHub.reconcileInputAttention(i),
            hostPolicyConnection: (hostId) => ({
              connected: options.hostHub.isConnected(hostId),
              features: options.hostHub.negotiatedFeatures(hostId),
            }),
          }
        : options;
    this.store = this.options.store;
    this.evaluator = this.options.evaluator ?? new PolicyEvaluator();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.store.tx(() => {
      for (const rule of builtinPolicyRules(this.store.nowIso())) {
        const marker = `policyBuiltinSeeded:${rule.id}`;
        if (!this.store.getSetting(marker, false)) {
          if (!this.getRule(rule.id)) this.writeRule(rule);
          this.store.setSetting(marker, true);
        }
      }
      this.settings();
    });
    for (const task of this.store.tasks.list()) {
      this.taskParents.set(task.id, task.parentTaskId ?? null);
      this.taskRoots.set(task.id, this.root(task).id);
      this.taskLimits.set(task.id, json(task.policy.continuation));
    }
    for (const run of this.store.runs.list()) this.runLimits.set(run.id, json(run.limits));
    this.store.hub.on("run.changed", this.onRunChanged);
    this.store.hub.on("task.changed", this.onTaskChanged);
    this.store.hub.on("event", this.onEvent);
    // Missing legacy leases and expired interactive waits must not regain authority on restart.
    this.invalidatePending();
    this.leaseSweeper = setInterval(() => this.invalidatePending(), 5_000);
    this.leaseSweeper.unref();
    // Policy-only recovery never resumes a captured agent mutation.
    for (const row of this.pendingRows()) {
      if (this.needsResume(row))
        void this.authorize(JSON.parse(row.input_json) as PolicyAuthorizeInput).catch(() =>
          this.cancelRow(this.decision(row.decision_id), stale),
        );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.initialized = false;
    if (this.leaseSweeper) clearInterval(this.leaseSweeper);
    this.leaseSweeper = null;
    this.store.hub.off("task.changed", this.onTaskChanged);
    this.store.hub.off("event", this.onEvent);
    this.store.hub.off("run.changed", this.onRunChanged);
    for (const callbacks of this.waiters.values()) for (const wake of callbacks) wake();
    await this.evaluator.close?.();
    await Promise.allSettled([...this.locks.values()]);
  }

  private readonly onTaskChanged = ({ id, task }: { id: string; task: Task | null }) => {
    const before = this.taskParents.get(id);
    const after = task?.parentTaskId ?? null;
    const oldRoot = this.taskRoots.get(id);
    if (!task || (before !== undefined && before !== after)) {
      const affected = new Set<string>(oldRoot ? [oldRoot] : []);
      if (task) affected.add(this.root(task).id);
      for (const rootId of affected)
        this.store.db
          .prepare("DELETE FROM policy_grants WHERE scope_kind = 'task' AND scope_id = ?")
          .run(rootId);
    } else if (!task.parentTaskId && (task.state === "done" || task.state === "canceled")) {
      this.store.db
        .prepare("DELETE FROM policy_grants WHERE scope_kind = 'task' AND scope_id = ?")
        .run(id);
    }
    if (task) {
      const limits = json(task.policy.continuation);
      if (this.taskLimits.has(id) && this.taskLimits.get(id) !== limits)
        this.store.db
          .prepare("DELETE FROM policy_grants WHERE scope_kind='task' AND scope_id=?")
          .run(this.root(task).id);
      this.taskLimits.set(id, limits);
      this.taskParents.set(id, after);
    } else {
      this.taskParents.delete(id);
      this.taskRoots.delete(id);
      this.taskLimits.delete(id);
    }
    for (const current of this.store.tasks.list())
      this.taskRoots.set(current.id, this.root(current).id);
    this.invalidatePending();
  };
  private readonly onRunChanged = (run: Run) => {
    const limits = json(run.limits);
    if (this.runLimits.has(run.id) && this.runLimits.get(run.id) !== limits) {
      const task = this.store.tasks.get(run.taskId);
      if (task)
        this.store.db
          .prepare("DELETE FROM policy_grants WHERE scope_kind='task' AND scope_id=?")
          .run(this.root(task).id);
    }
    this.runLimits.set(run.id, limits);
  };
  private readonly onEvent = (event: { type: string }) => {
    if (
      event.type === "session.updated" ||
      event.type === "session.deleted" ||
      event.type === "run.updated"
    )
      this.invalidatePending();
  };

  /** Trusted broker-only bind; intentionally synchronous so it joins AgentService's transaction. */
  bindBoundary(owner: PolicyOwner, raw: HostPolicyBoundary): void {
    const boundary = parse(HostPolicyBoundary, raw);
    const session = this.store.sessions.require(owner.sessionId);
    if (session.hostId !== owner.authenticatedHostId)
      throw new SwitchyardError("forbidden", "The policy boundary belongs to another host.");
    const workspace = session.workspaceId
      ? this.store.workspaces.require(session.workspaceId)
      : null;
    if (
      workspace &&
      (workspace.hostId !== session.hostId || workspace.projectId !== session.projectId)
    )
      throw new SwitchyardError(
        "forbidden",
        "Cannot verify workspace boundary for policy enforcement.",
      );
    if (
      !session.cwd.startsWith("/") ||
      session.cwd.includes("\0") ||
      (workspace && (!workspace.path.startsWith("/") || workspace.path.includes("\0")))
    )
      throw new SwitchyardError(
        "forbidden",
        "Cannot verify workspace boundary for policy enforcement.",
      );
    if (
      boundary.cwd !== posix.resolve(session.cwd) ||
      boundary.workspaceRoot !== posix.resolve(workspace?.path ?? session.cwd)
    )
      throw new SwitchyardError(
        "forbidden",
        "Cannot verify workspace boundary for policy enforcement.",
      );
    const existing = this.boundary(owner);
    if (existing && !equal(existing, boundary))
      throw new SwitchyardError("conflict", "A policy runtime boundary cannot be repinned.");
    this.store.db
      .prepare(`INSERT OR IGNORE INTO policy_runtime_boundaries
      (session_id,native_session_id,runtime_id,host_id,boundary_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(
        owner.sessionId,
        owner.nativeSessionId,
        owner.runtimeId,
        owner.authenticatedHostId,
        json(boundary),
        this.store.nowIso(),
      );
  }

  private boundary(owner: PolicyOwner): HostPolicyBoundary | null {
    const row = this.store.db
      .prepare(`SELECT host_id,boundary_json FROM policy_runtime_boundaries
      WHERE session_id=? AND native_session_id=? AND runtime_id=?`)
      .get(owner.sessionId, owner.nativeSessionId, owner.runtimeId) as
      | { host_id: string; boundary_json: string }
      | undefined;
    if (!row) return null;
    if (row.host_id !== owner.authenticatedHostId)
      throw new SwitchyardError("forbidden", "Policy boundary host mismatch.");
    return parse(HostPolicyBoundary, JSON.parse(row.boundary_json));
  }

  private ownedSession(owner: PolicyOwner): Session {
    const session = this.store.sessions.require(owner.sessionId);
    const host = this.store.hosts.require(owner.authenticatedHostId);
    if (session.hostId !== host.id || host.revokedAt)
      throw new SwitchyardError("forbidden", "Policy caller is not owned by this host.");
    if (
      session.bridge?.nativeSessionId !== owner.nativeSessionId ||
      session.bridge.runtimeId !== owner.runtimeId ||
      (session.nativeHandle !== null && session.nativeHandle.sessionId !== owner.nativeSessionId)
    )
      throw new SwitchyardError("stale_control", "The policy runtime binding changed.");
    if (
      session.readOnly ||
      session.archivedAt ||
      ["stopped", "failed", "interrupted"].includes(session.runtime)
    )
      throw new SwitchyardError(
        "forbidden",
        "This session cannot execute policy-protected actions.",
      );
    return session;
  }

  private root(task: Task): Task {
    let current = task;
    const seen = new Set<string>();
    while (current.parentTaskId) {
      if (seen.has(current.id) || seen.size >= 16)
        throw new SwitchyardError("conflict", "Invalid task hierarchy.");
      seen.add(current.id);
      const parent = this.store.tasks.get(current.parentTaskId);
      if (!parent) throw new SwitchyardError("stale_control", stale);
      if (parent.projectId !== task.projectId)
        throw new SwitchyardError("conflict", "Invalid task hierarchy.");
      current = parent;
    }
    return current;
  }

  /** Shared durable root identity for policy snapshots and continuation recovery. */
  rootFence(taskId: string | null): PolicyRootStamp | null {
    if (taskId === null) return null;
    const task = this.store.tasks.get(taskId);
    if (!task) throw new SwitchyardError("stale_control", stale);
    return this.rootStamp(this.root(task));
  }

  private terminal(task: Task): boolean {
    return task.state === "done" || task.state === "canceled";
  }

  private rootStamp(root: Task): PolicyRootStamp {
    const epoch = this.store.getSetting<number>(`policyRootEpoch:${root.id}`, 0);
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw new SwitchyardError("stale_control", "Invalid policy root epoch.");
    return { id: root.id, state: root.state, updatedAt: root.updatedAt, epoch };
  }

  private nextLease(): string {
    return new Date(Date.parse(this.store.nowIso()) + waitLeaseMs).toISOString();
  }

  private leaseIsExpired(row: EvaluationRow): boolean {
    if (row.verdict !== "ASK" || JSON.parse(row.input_json).kind === "continuation") return false;
    return (
      !row.wait_lease_until ||
      !Number.isFinite(Date.parse(row.wait_lease_until)) ||
      Date.parse(row.wait_lease_until) <= Date.parse(this.store.nowIso())
    );
  }

  private build(
    input:
      | PolicyAuthorizeInput
      | { kind: "test"; request: PolicyTestRequest; sample?: HostPolicySampleResult },
    reservedContinuation = false,
  ): Snapshot {
    let session: Session;
    let owner: PolicyOwner | null = null;
    let run: Run | null = null;
    let key: string;
    let args: PolicyContext["request"] = null;
    let tool: PolicyContext["tool"] = null;
    let logical: unknown;
    let defaultBranch: string | null = null;
    if (input.kind === "test") {
      session = this.store.sessions.require(input.request.sessionId);
      const bridge = session.bridge;
      const host = this.store.hosts.require(session.hostId);
      if (
        bridge?.policyState !== "active" ||
        !bridge.policyPhases.includes(input.request.phase) ||
        !bridge.nativeSessionId ||
        !bridge.runtimeId ||
        (session.nativeHandle !== null &&
          session.nativeHandle.sessionId !== bridge.nativeSessionId) ||
        host.revokedAt ||
        session.archivedAt ||
        ["stopped", "failed", "interrupted"].includes(session.runtime)
      )
        throw new SwitchyardError("unsupported_capability", testUnsupported);
      owner = {
        authenticatedHostId: session.hostId,
        sessionId: session.id,
        nativeSessionId: bridge.nativeSessionId,
        runtimeId: bridge.runtimeId,
      };
      if (
        input.request.phase === "tool_call" &&
        (host.connectivity !== "connected" || session.connectivity !== "connected")
      )
        throw new SwitchyardError("host_unreachable", "The policy test host is not connected.");
      run = session.runId ? this.store.runs.require(session.runId) : null;
      args = input.request.request;
      defaultBranch = input.sample?.defaultBranch ?? null;
      tool = input.request.tool
        ? { ...input.request.tool, safety: input.sample?.safety ?? emptySafety }
        : null;
      logical = input.request;
      key = "pol_test";
    } else if (input.kind === "continuation") {
      if (!reservedContinuation) this.assertContinuationAuthorizationCurrent(input);
      if (
        ![
          input.expectedControlRevision,
          input.nextContinuationNumber,
          input.expectedSettleCount,
        ].every(positive)
      )
        throw new SwitchyardError(
          "invalid_request",
          "Invalid continuation authorization identity.",
        );
      if (input.expectedWatermark !== null) parse(CompletedUsageWatermark, input.expectedWatermark);
      run = this.store.runs.require(input.runId);
      // Only the reserved form may reconstruct the pre-reservation count, and only after
      // proving that the physical run still contains precisely this reservation. Never
      // write that normalized copy back to Store or expose it to ordinary authorization.
      if (reservedContinuation) {
        if (run.continuationsUsed !== input.nextContinuationNumber)
          throw new SwitchyardError("stale_control", stale);
        run = { ...run, continuationsUsed: run.continuationsUsed - 1 };
      }
      session = this.store.sessions.require(run.sessionId ?? "");
      const task = this.store.tasks.require(run.taskId);
      if (
        task.currentRunId !== run.id ||
        session.runId !== run.id ||
        session.taskId !== task.id ||
        run.controlMode !== "automation" ||
        run.controlRevision !== input.expectedControlRevision ||
        input.nextContinuationNumber !== run.continuationsUsed + 1 ||
        this.store.runSettleCount(run.id) !== input.expectedSettleCount ||
        session.runtime !== "idle" ||
        session.compacting ||
        session.readOnly ||
        session.archivedAt ||
        run.state !== "running" ||
        (input.expectedWatermark !== null &&
          session.stats?.watermark &&
          !equal(input.expectedWatermark, session.stats.watermark))
      )
        throw new SwitchyardError("stale_control", stale);
      owner = session.bridge
        ? {
            authenticatedHostId: session.hostId,
            sessionId: session.id,
            nativeSessionId: session.bridge.nativeSessionId,
            runtimeId: session.bridge.runtimeId,
          }
        : null;
      if (owner) this.ownedSession(owner);
      logical = [
        1,
        run.id,
        run.attempt,
        input.expectedControlRevision,
        input.nextContinuationNumber,
        input.expectedSettleCount,
        input.expectedWatermark,
      ];
      key = `pol_${hash(logical as Parameters<typeof hash>[0])}`;
      args = {
        method: "run.continue",
        args: {
          runId: run.id,
          nextContinuationNumber: input.nextContinuationNumber,
        },
      };
    } else {
      owner = input.owner;
      session = this.ownedSession(owner);
      const frame = input.frame;
      if (
        frame.sessionId !== owner.sessionId ||
        frame.nativeSessionId !== owner.nativeSessionId ||
        frame.runtimeId !== owner.runtimeId ||
        !frame.toolCallId
      )
        throw new SwitchyardError("forbidden", "Policy request identity mismatch.");
      if (input.kind === "tool") {
        if (frame.method !== "policy.evaluate")
          throw new SwitchyardError("invalid_request", "Expected policy.evaluate.");
        const request = parse(PolicyEvaluateRequest, frame.args);
        const proof = parse(HostToolPolicyContext, input.hostContext);
        key = `pol_${createHash("sha256")
          .update(
            JSON.stringify([session.id, owner.nativeSessionId, "tool_call", frame.toolCallId]),
          )
          .digest("hex")}`;
        if (
          request.toolCallId !== frame.toolCallId ||
          request.evaluationId !== key ||
          proof.toolCallId !== frame.toolCallId ||
          proof.toolHash !== hash(request.tool)
        )
          throw new SwitchyardError("forbidden", "Policy tool identity or hash mismatch.");
        if (!equal(proof.boundary, this.boundary(owner)))
          throw new SwitchyardError(
            "stale_control",
            "The verified policy workspace boundary changed.",
          );
        defaultBranch = proof.defaultBranch;
        tool = { ...request.tool, safety: proof.safety };
        logical = { kind: "tool", tool: request.tool };
      } else {
        let normalized: Record<string, unknown>;
        switch (frame.method) {
          case "task.create":
            normalized = parse(CreateAgentTask, frame.args);
            break;
          case "message.send":
            normalized = parse(SendAgentMessage, frame.args);
            break;
          case "inbox.read":
            normalized = parse(ReadAgentInbox, frame.args);
            break;
          default:
            throw new SwitchyardError("invalid_request", "Invalid request policy action.");
        }
        args = {
          method: frame.method,
          args: normalized as NonNullable<PolicyContext["request"]>["args"],
        };
        key = `pol_${hash([1, session.id, owner.nativeSessionId, "request", frame.method, frame.toolCallId])}`;
        logical = args;
      }
      if (session.runId) run = this.store.runs.require(session.runId);
    }
    const rootStamp = this.rootFence(session.taskId);
    const task = session.taskId ? this.store.tasks.require(session.taskId) : null;
    if (run && (run.sessionId !== session.id || (task && task.currentRunId !== run.id)))
      throw new SwitchyardError("stale_control", stale);
    if (
      input.kind !== "test" &&
      rootStamp &&
      (rootStamp.state === "done" || rootStamp.state === "canceled")
    )
      throw new SwitchyardError("forbidden", rootEnded);
    const scope: Scope = rootStamp
      ? { kind: "task", id: rootStamp.id }
      : { kind: "session", id: session.id };
    const pinned = owner ? this.boundary(owner) : null;
    if (!pinned)
      throw new SwitchyardError(
        input.kind === "test" ? "unsupported_capability" : "forbidden",
        input.kind === "test"
          ? testUnsupported
          : "Cannot verify workspace boundary for policy enforcement.",
      );
    if (input.kind === "test" && input.sample && !equal(input.sample.boundary, pinned))
      throw new SwitchyardError("stale_control", "The verified policy workspace boundary changed.");
    const currentWorkspace = session.workspaceId
      ? this.store.workspaces.require(session.workspaceId)
      : null;
    if (
      !session.cwd.startsWith("/") ||
      pinned.cwd !== posix.resolve(session.cwd) ||
      pinned.workspaceRoot !== posix.resolve(currentWorkspace?.path ?? session.cwd) ||
      (currentWorkspace &&
        (currentWorkspace.hostId !== session.hostId ||
          currentWorkspace.projectId !== session.projectId))
    )
      throw new SwitchyardError("stale_control", "The stored policy workspace boundary changed.");
    // Snapshot construction is read-only, including the final transaction assertion.
    const settings = PolicySettings.parse(
      this.store.getSetting("policySettings", {
        revision: 1,
        modelClassifications: [],
        updatedAt: this.store.nowIso(),
      }),
    );
    const provider = session.model?.provider ?? session.profileSnapshot.provider ?? null;
    const modelId = session.model?.id ?? session.profileSnapshot.model ?? null;
    const classification =
      settings.modelClassifications.find((m) => m.provider === provider && m.modelId === modelId)
        ?.classification ?? "unclassified";
    const limits = run?.limits.enabled ? run.limits : null;
    const tokens = session.stats?.tokens ?? null;
    const costUsd = session.stats?.costUsd ?? null;
    const watermark = session.stats?.watermark ?? null;
    const cost: PolicyContext["cost"] = {
      tokens,
      costUsd,
      maxTokens: limits?.maxTokens ?? null,
      maxCostUsd: limits?.maxCostUsd ?? null,
      accounting: tokens !== null || costUsd !== null ? "available" : "unavailable",
      fresh:
        input.kind === "test"
          ? watermark !== null
          : input.kind === "continuation" &&
            input.expectedWatermark !== null &&
            equal(input.expectedWatermark, watermark),
      watermark,
      provider,
      modelId,
      classification,
      expensive: classification !== "cheap",
    };
    const target =
      args?.method === "message.send"
        ? this.store.sessions.require(String(args.args.sessionId))
        : null;
    const targetRun = target?.runId ? this.store.runs.require(target.runId) : null;
    const context: Omit<PolicyContext, "counters"> = {
      phase: tool ? "tool_call" : "request",
      action: tool ? "tool.call" : args!.method,
      tool,
      request: args,
      session: {
        id: session.id,
        hostId: session.hostId,
        nativeSessionId: owner?.nativeSessionId ?? null,
        runtimeId: owner?.runtimeId ?? null,
        profileId: session.profileSnapshot.id,
        projectId: session.projectId,
        taskId: session.taskId,
        runId: session.runId,
        controlMode: run?.controlMode ?? "human",
        controlRevision: run?.controlRevision ?? 1,
        cwd: pinned.cwdReal,
        workspaceRoot: pinned.workspaceRootReal,
        repository: session.projectId
          ? this.store.projects.require(session.projectId).repoIdentity
          : null,
        defaultBranch,
        readOnly: session.readOnly,
      },
      task:
        task && rootStamp
          ? {
              id: task.id,
              projectId: task.projectId,
              rootTaskId: rootStamp.id,
              parentTaskId: task.parentTaskId ?? null,
              title: task.title,
              state: task.state,
            }
          : null,
      target: target
        ? {
            id: target.id,
            hostId: target.hostId,
            projectId: target.projectId,
            taskId: target.taskId,
            controlMode: targetRun?.controlMode ?? "human",
            controlRevision: targetRun?.controlRevision ?? 1,
            runtime: target.runtime,
            readOnly: target.readOnly,
          }
        : null,
      cost,
    };
    if (Buffer.byteLength(json({ ...context, counters: {} })) > 65536)
      throw new SwitchyardError("invalid_request", "Policy input is too large to evaluate.");
    parse(PolicyContext, { ...context, counters: {} });
    const rules = this.listRules().filter(
      (r) =>
        r.enabled &&
        r.phases.includes(context.phase) &&
        (r.scope === "server" ||
          (r.scope === "session" && r.scopeId === session.id) ||
          (r.scope === "profile" && r.scopeId === session.profileSnapshot.id)),
    );
    if (rules.length > 128)
      throw new SwitchyardError(
        "invalid_request",
        "At most 128 enabled policy rules may be evaluated.",
      );
    const counters: Record<string, Counter> = {};
    for (const rule of rules) {
      const row = this.store.db
        .prepare(`SELECT counters_json,version FROM policy_counters
        WHERE scope_kind=? AND scope_id=? AND rule_id=?`)
        .get(scope.kind, scope.id, rule.id) as
        | { counters_json: string; version: number }
        | undefined;
      counters[rule.id] = {
        values: row ? PolicyCounterMap.parse(JSON.parse(row.counters_json)) : {},
        version: row?.version ?? 0,
      };
    }
    const accountingBlocked =
      (input.kind === "continuation" ||
        (input.kind === "test" && args?.method === "run.continue")) &&
      ((cost.maxTokens !== null && (tokens === null || !cost.fresh)) ||
        (cost.maxCostUsd !== null && (costUsd === null || !cost.fresh)));
    return {
      key,
      hash: hash(logical as Parameters<typeof hash>[0]),
      owner,
      scope,
      context,
      rules,
      counters,
      accountingBlocked,
      rootStamp,
      revisions: json({
        context,
        rootStamp,
        boundary: pinned,
        workspaceId: session.workspaceId,
        bridgeIdentity: session.bridge
          ? {
              version: session.bridge.version,
              runtimeId: session.bridge.runtimeId,
              nativeSessionId: session.bridge.nativeSessionId,
              controllerEpoch: session.bridge.controllerEpoch ?? null,
            }
          : null,
        rules,
        settingsRevision: settings.revision,
        callerContext:
          input.kind === "tool" || input.kind === "agent_request" ? input.frame.context : null,
        taskContinuationLimits: task?.policy.continuation ?? null,
        counterVersions: Object.fromEntries(
          Object.entries(counters).map(([id, c]) => [id, c.version]),
        ),
        runFence: run
          ? {
              attempt: run.attempt,
              continuationsUsed: run.continuationsUsed,
              limits: run.limits,
              settleCount: this.store.runSettleCount(run.id),
            }
          : null,
        ...(input.kind === "continuation"
          ? {
              continuationFence: {
                runtime: session.runtime,
                compacting: session.compacting ?? false,
              },
            }
          : {}),
        ...(input.kind === "test"
          ? {
              testFence: {
                boundary: pinned,
                workspaceId: session.workspaceId,
              },
            }
          : {}),
      }),
    };
  }

  private lock<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    const key = `${scope.kind}:${scope.id}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => {});
    return next;
  }

  async authorize(input: PolicyAuthorizeInput): Promise<PolicyEvaluation> {
    // Also catch missed/delayed lifecycle events before consulting a shared grant or ALLOW row.
    this.invalidatePending();
    try {
      const initial = this.build(input);
      return await this.lock(initial.scope, () =>
        this.authorizeLocked(input, false, initial.scope),
      );
    } catch (error) {
      if (error instanceof SwitchyardError && error.message === rootEnded)
        return { verdict: "DENY", reason: rootEnded };
      throw error;
    }
  }

  /** Read-only final fence, called inside the mutation's transaction/savepoint. */
  assertAuthorized(input: PolicyAuthorizeInput): void {
    input.signal?.throwIfAborted();
    const snapshot = this.build(input);
    this.assertAllowedSnapshot(snapshot);
  }

  private assertAllowedSnapshot(snapshot: Snapshot): EvaluationRow {
    const row = this.rowByKey(snapshot.key);
    if (
      !row ||
      row.canceled ||
      row.verdict !== "ALLOW" ||
      row.request_hash !== snapshot.hash ||
      row.revisions_json !== snapshot.revisions ||
      row.scope_kind !== snapshot.scope.kind ||
      row.scope_id !== snapshot.scope.id ||
      row.session_id !== snapshot.context.session.id ||
      (JSON.parse(row.result_json) as PolicyEvaluation).verdict !== "ALLOW"
    )
      throw new SwitchyardError("stale_control", stale);
    return row;
  }

  /** Read-only proof first, then a separate current-connection send gate. */
  checkReservedContinuation(
    input: ContinuationAuthorization,
    expectedContext: string,
  ): ReservedContinuationReadiness {
    input.signal?.throwIfAborted();
    try {
      this.reservedContinuationSnapshot(input, expectedContext);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof SwitchyardError && error.code === "stale_control") throw error;
      throw new SwitchyardError("stale_control", stale);
    }
    const pending = this.store.getSetting<PendingContinuation | null>(
      CONTINUATION_PREFIX + input.runId,
      null,
    );
    return this.checkContinuationAvailability(input.runId, pending!.source);
  }

  /** Read-only D.7 readiness gate shared by unspent authorization and reserved delivery. */
  checkContinuationAvailability(
    runId: string,
    expectedSource: ContinuationSource,
  ): ReservedContinuationReadiness {
    const run = this.store.runs.require(runId);
    const session = this.store.sessions.require(run.sessionId ?? "");
    const host = this.store.hosts.require(session.hostId);
    if (
      host.revokedAt ||
      run.hostId !== session.hostId ||
      !expectedSource?.runtimeId ||
      !expectedSource.nativeSessionId ||
      !expectedSource.controllerEpoch ||
      !equal(continuationSource(session), expectedSource) ||
      (session.nativeHandle !== null &&
        session.nativeHandle.sessionId !== expectedSource.nativeSessionId)
    )
      throw new SwitchyardError("stale_control", stale);
    let connection:
      | ReturnType<NonNullable<PolicyServiceOptions["hostPolicyConnection"]>>
      | undefined;
    try {
      connection = this.options.hostPolicyConnection?.(host.id);
    } catch {
      // An unknown connection cannot authorize a write or confirm an incompatibility.
    }
    if (!connection?.connected)
      return { state: "defer", reason: "Waiting for the host to reconnect." };
    if (
      !connection.features.has("agentRequests.v1") ||
      !connection.features.has("policies.v1") ||
      !host.piCompatible ||
      host.capabilities?.agentRequests !== true ||
      host.capabilities.policies !== true
    )
      throw new SwitchyardError("unsupported_capability", POLICY_LAUNCH_UNAVAILABLE);
    const bridge = session.bridge!; // Captured source was checked before availability.
    if (bridge.policyState === "unsupported")
      throw new SwitchyardError("unsupported_capability", POLICY_LAUNCH_UNAVAILABLE);
    if (bridge.policyState !== "active")
      return { state: "defer", reason: "Waiting for policy enforcement to reconnect." };
    const requirement = policyLaunchRequirement(
      { sessionId: session.id, profileId: session.profileSnapshot.id, continuation: run.limits },
      this.listRules(),
      this.store.getSetting("policySettings", { revision: 1 }).revision,
    );
    if (
      !bridge.policyPhases.includes("request") ||
      (requirement.required && !bridge.policyPhases.includes("tool_call"))
    )
      throw new SwitchyardError("unsupported_capability", POLICY_LAUNCH_UNAVAILABLE);
    return { state: "ready" };
  }

  /** Compatibility wrapper for callers that cannot retain a deferred in-memory frame. */
  assertReservedContinuation(input: ContinuationAuthorization, expectedContext: string): void {
    const readiness = this.checkReservedContinuation(input, expectedContext);
    if (readiness.state === "defer")
      throw new SwitchyardError("host_unreachable", readiness.reason, { deferred: true });
  }

  private reservedContinuationSnapshot(
    input: ContinuationAuthorization,
    expectedContext: string,
  ): Snapshot {
    const pending = this.store.getSetting<PendingContinuation | null>(
      CONTINUATION_PREFIX + input.runId,
      null,
    );
    const { signal: _signal, ...persistedInput } = input;
    if (
      input.kind !== "continuation" ||
      pending?.version !== 3 ||
      pending.phase !== "delivery" ||
      !["not_sent", "may_have_sent"].includes(pending.deliveryAttempt) ||
      pending.context !== expectedContext ||
      pending.n !== input.nextContinuationNumber ||
      !equal(pending.input, persistedInput)
    )
      throw new SwitchyardError("stale_control", stale);
    const run = this.store.runs.require(input.runId);
    const session = this.store.sessions.require(run.sessionId ?? "");
    const task = this.store.tasks.require(run.taskId);
    if (
      !pending.source?.runtimeId ||
      !pending.source.nativeSessionId ||
      !pending.source.controllerEpoch ||
      pending.source.runtimeId !== session.bridge?.runtimeId ||
      pending.source.nativeSessionId !== session.bridge?.nativeSessionId ||
      pending.source.controllerEpoch !== session.bridge?.controllerEpoch ||
      run.continuationsUsed !== pending.n ||
      run.hostId !== session.hostId ||
      task.projectId !== session.projectId ||
      !this.store.getSetting("policySettings", null) ||
      continuationContext(this.store, this, run) !== expectedContext
    )
      throw new SwitchyardError("stale_control", stale);
    const snapshot = this.build(input, true);
    const row = this.assertAllowedSnapshot(snapshot);
    if (
      !equal(JSON.parse(row.input_json), persistedInput) ||
      (pending.decisionId !== null && pending.decisionId !== row.decision_id)
    )
      throw new SwitchyardError("stale_control", stale);
    return snapshot;
  }

  private async authorizeLocked(
    input: PolicyAuthorizeInput,
    resume = false,
    heldScope?: Scope,
  ): Promise<PolicyEvaluation> {
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal?.throwIfAborted();
      const snapshot = this.build(input);
      if (heldScope && !equal(heldScope, snapshot.scope))
        throw new SwitchyardError("stale_control", stale);
      const prior = this.rowByKey(snapshot.key);
      if (prior) {
        this.refreshPending(prior);
        if (prior.request_hash !== snapshot.hash)
          throw new SwitchyardError(
            "conflict",
            "Policy evaluation identity was reused with different arguments.",
          );
        if (this.decision(prior.decision_id).canceled)
          throw new SwitchyardError("stale_control", stale);
        if (prior.revisions_json !== snapshot.revisions) {
          this.cancelRow(prior, stale);
          throw new SwitchyardError("stale_control", stale);
        }
        if ((!resume && !this.needsResume(prior)) || prior.verdict !== "ASK")
          return JSON.parse(prior.result_json) as PolicyEvaluation;
      }
      const evaluated = snapshot.accountingBlocked
        ? null
        : await this.evaluate(snapshot, false, undefined, () =>
            this.assertContinuationAuthorizationCurrent(input),
          );
      this.assertContinuationAuthorizationCurrent(input);
      input.signal?.throwIfAborted();
      let latest: Snapshot;
      try {
        latest = this.build(input);
      } catch (error) {
        if (prior) this.cancelRow(prior, stale);
        throw error;
      }
      // A worker await may outlive an interactive wait even without a sweeper tick.
      if (prior) this.refreshPending(this.decision(prior.decision_id));
      if (this.rowByKey(snapshot.key)?.canceled) throw new SwitchyardError("stale_control", stale);
      if (snapshot.revisions !== latest.revisions) continue;
      const result = evaluated ?? {
        verdict: "DENY" as const,
        reason: BUDGET_ACCOUNTING_UNAVAILABLE,
        trace: [],
        proposedStateUpdates: {},
        enforcement: this.enforcement(),
      };
      return this.store.tx(() => {
        // Discard can run while a worker (or this scope's lock queue) is suspended.
        // No interaction, counter update or ALLOW may survive that authorization fence.
        this.assertContinuationAuthorizationCurrent(input);
        const decisionId = prior?.decision_id ?? `pdec_${randomUUID()}`;
        let reply: PolicyEvaluation;
        let interactionId: string | null = null;
        if (result.verdict === "ASK") {
          const ask = result.trace.find((t) => t.verdict === "ASK" && !t.granted && !t.overridden)!;
          const rule = snapshot.rules.find((r) => r.id === ask.ruleId)!;
          const fingerprint = this.fingerprint(
            snapshot,
            rule,
            this.askMetric(snapshot, result.trace),
          );
          const interaction: Interaction = {
            id: newId("int"),
            sessionId: snapshot.context.session.id,
            revision: prior?.interaction_id
              ? this.store.interactions.require(prior.interaction_id).revision + 1
              : 1,
            source: { kind: "extension_ui", method: "confirm", piRequestIds: [] },
            adapterId: null,
            permission: {
              kind: "policy",
              decisionId,
              rootTaskId: snapshot.context.task?.rootTaskId ?? null,
              ruleId: rule.id,
              ruleRevision: rule.revision,
              fingerprint,
            },
            title: `Allow ${snapshot.context.action}?`,
            presentation: {
              t: "confirm",
              message: `${result.reason}\n\n${json(
                snapshot.context.tool
                  ? { name: snapshot.context.tool.name, args: snapshot.context.tool.args }
                  : snapshot.context.request,
              )}`,
              confirmLabel: "Allow matching action",
              cancelLabel: "Deny",
            },
            state: "pending",
            resolution: null,
            createdAt: this.store.nowIso(),
          };
          this.putInteraction(interaction);
          interactionId = interaction.id;
          reply = {
            verdict: "ASK",
            decisionId,
            interactionId,
            interactionUrl: `${this.options.publicUrl.replace(/\/$/, "")}/code/${encodeURIComponent(interaction.sessionId)}`,
          };
        } else {
          if (result.verdict === "ALLOW") reply = { verdict: "ALLOW" };
          else reply = { verdict: "DENY", reason: result.reason || unavailable };
          // A failure has no updates. Each patch replaces only its own rule's keys.
          this.commitUpdates(snapshot, result.proposedStateUpdates);
        }
        const persistedInput = { ...input };
        delete persistedInput.signal;
        const now = this.store.nowIso();
        // Save post-commit counter versions, allowing completed replays without applying updates twice.
        const revisions = this.build(input).revisions;
        this.store.db
          .prepare(`INSERT INTO policy_evaluations
          (evaluation_key,request_hash,scope_kind,scope_id,session_id,revisions_json,input_json,
           provisional_updates_json,verdict,decision_id,interaction_id,result_json,canceled,created_at,updated_at,wait_lease_until)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(evaluation_key) DO UPDATE SET
          revisions_json=excluded.revisions_json,provisional_updates_json=excluded.provisional_updates_json,verdict=excluded.verdict,
          interaction_id=excluded.interaction_id,result_json=excluded.result_json,updated_at=excluded.updated_at,
          wait_lease_until=excluded.wait_lease_until`)
          .run(
            snapshot.key,
            snapshot.hash,
            snapshot.scope.kind,
            snapshot.scope.id,
            snapshot.context.session.id,
            revisions,
            JSON.stringify(persistedInput),
            json(result.proposedStateUpdates),
            reply.verdict,
            decisionId,
            interactionId,
            json(reply),
            now,
            now,
            reply.verdict === "ASK" && input.kind !== "continuation"
              ? (prior?.wait_lease_until ?? this.nextLease())
              : null,
          );
        this.wake(decisionId);
        return reply;
      });
    }
    return { verdict: "DENY", reason: unavailable };
  }

  private commitUpdates(snapshot: Snapshot, patches: Record<string, PolicyCounterMap>): void {
    for (const [ruleId, patch] of Object.entries(patches)) {
      if (!Object.keys(patch).length) continue;
      const counter = snapshot.counters[ruleId]!;
      const values = PolicyCounterMap.parse({ ...counter.values, ...patch });
      this.store.db
        .prepare(`INSERT INTO policy_counters(scope_kind,scope_id,rule_id,counters_json,version)
        VALUES (?,?,?,?,?) ON CONFLICT(scope_kind,scope_id,rule_id)
        DO UPDATE SET counters_json=excluded.counters_json,version=excluded.version`)
        .run(snapshot.scope.kind, snapshot.scope.id, ruleId, json(values), counter.version + 1);
    }
  }

  private enforcement(): PolicyTestResult["enforcement"] {
    return {
      phases: ["tool_call", "request"],
      modelRequest: false,
      explanation: POLICY_CAPABILITY_EXPLANATION,
    };
  }

  /** Pure aggregation of worker results, approval grants and scope precedence. */
  private async evaluate(
    snapshot: Snapshot,
    tester = false,
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ): Promise<PolicyTestResult> {
    const trace: PolicyTrace[] = [];
    const updates: Record<string, PolicyCounterMap> = {};
    let sessionAllow = false;
    let final: PolicyTestResult["verdict"] = "ALLOW";
    let reason: string | null = null;
    try {
      // Soft metrics are evaluated in deterministic order with separate narrow fingerprints.
      for (const rule of snapshot.rules) {
        const metrics: ("tokens" | "usd" | null)[] =
          softBudget(rule) && snapshot.context.action === "run.continue"
            ? [
                ...(snapshot.context.cost.maxTokens !== null ? ["tokens" as const] : []),
                ...(snapshot.context.cost.maxCostUsd !== null ? ["usd" as const] : []),
              ]
            : [null];
        for (const metric of metrics) {
          const context = metric
            ? {
                ...snapshot.context,
                cost: {
                  ...snapshot.context.cost,
                  ...(metric === "tokens" ? { maxCostUsd: null } : { maxTokens: null }),
                },
              }
            : snapshot.context;
          signal?.throwIfAborted();
          assertCurrent?.();
          const evaluated = await abortable(
            this.evaluator.evaluateRules([rule], context, {
              [rule.id]: snapshot.counters[rule.id]!.values,
            }),
            signal,
          );
          assertCurrent?.();
          const entry = evaluated[0];
          if (
            evaluated.length !== 1 ||
            !entry ||
            entry.ruleId !== rule.id ||
            entry.ruleRevision !== rule.revision ||
            entry.error
          ) {
            final = "DENY";
            reason = entry?.error?.message
              ? `Policy evaluation failed: ${entry.error.message}`.slice(0, 4000)
              : unavailable;
            const failureTrace: PolicyTrace = {
              ruleId: rule.id,
              ruleRevision: rule.revision,
              scope: rule.scope,
              scopeId: rule.scopeId,
              verdict: "DENY",
              reason,
              granted: false,
              overridden: false,
              proposedStateUpdates: {},
            };
            const existing = trace.findIndex((t) => t.ruleId === rule.id);
            if (existing >= 0) trace[existing] = failureTrace;
            else trace.push(failureTrace);
            return {
              verdict: final,
              reason,
              trace,
              proposedStateUpdates: {},
              enforcement: this.enforcement(),
            };
          }
          const result = entry.result;
          const granted =
            result?.verdict === "ASK" &&
            !tester &&
            this.hasGrant(snapshot.scope, rule, this.fingerprint(snapshot, rule, metric));
          const overridden = result?.verdict === "ASK" && rule.scope === "profile" && sessionAllow;
          const item: PolicyTrace = {
            ruleId: rule.id,
            ruleRevision: rule.revision,
            scope: rule.scope,
            scopeId: rule.scopeId,
            verdict: result?.verdict ?? null,
            reason: result?.reason ?? null,
            granted,
            overridden,
            proposedStateUpdates: { ...(updates[rule.id] ?? {}), ...(result?.state_updates ?? {}) },
          };
          const priorTrace = trace.findIndex((t) => t.ruleId === rule.id);
          if (priorTrace >= 0) trace[priorTrace] = item;
          else trace.push(item);
          if (result?.state_updates) {
            const patch = { ...(updates[rule.id] ?? {}), ...result.state_updates };
            PolicyCounterMap.parse({ ...snapshot.counters[rule.id]!.values, ...patch });
            updates[rule.id] = patch;
          }
          if (result?.verdict === "ALLOW" && rule.scope === "session") sessionAllow = true;
          if (result && result.verdict !== "ALLOW" && !granted && !overridden) {
            final = result.verdict;
            reason = result.reason;
            return {
              verdict: final,
              reason,
              trace,
              proposedStateUpdates: updates,
              enforcement: this.enforcement(),
            };
          }
        }
      }
    } catch {
      // Worker failure must not swallow a concurrent authorization cancellation either.
      assertCurrent?.();
      return {
        verdict: "DENY",
        reason: unavailable,
        trace,
        proposedStateUpdates: {},
        enforcement: this.enforcement(),
      };
    }
    return {
      verdict: final,
      reason,
      trace,
      proposedStateUpdates: updates,
      enforcement: this.enforcement(),
    };
  }

  private askMetric(snapshot: Snapshot, trace: PolicyTrace[]): "tokens" | "usd" | null {
    const ask = trace.find((t) => t.verdict === "ASK" && !t.granted && !t.overridden);
    if (!ask) return null;
    const rule = snapshot.rules.find((r) => r.id === ask.ruleId)!;
    if (!softBudget(rule)) return null;
    const { maxTokens, tokens } = snapshot.context.cost;
    return maxTokens !== null &&
      tokens !== null &&
      tokens >= maxTokens * 0.8 &&
      !this.hasGrant(snapshot.scope, rule, this.fingerprint(snapshot, rule, "tokens"))
      ? "tokens"
      : "usd";
  }

  private fingerprint(
    snapshot: Snapshot,
    rule: PolicyRule,
    metric: "tokens" | "usd" | null,
  ): string {
    if (rule.id === "continuation-soft-budget" && metric)
      return hash([
        rule.revision,
        "request",
        "run.continue",
        snapshot.scope.id,
        snapshot.rootStamp?.epoch ?? null,
        metric,
        metric === "tokens" ? snapshot.context.cost.maxTokens : snapshot.context.cost.maxCostUsd,
      ]);
    const c = snapshot.context;
    return hash({
      // A physically retained historical grant must never cross a terminal/reopen epoch,
      // even if its original ALLOW row was already canceled before the lifecycle event.
      rootEpoch: snapshot.rootStamp?.epoch ?? null,
      ruleRevision: rule.revision,
      phase: c.phase,
      action: c.action,
      tool: c.tool ? { name: c.tool.name, args: c.tool.args } : null,
      request: c.request,
      projectId: c.session.projectId,
      repository: c.session.repository,
      cwd: c.session.cwd,
      workspaceRoot: c.session.workspaceRoot,
      target: c.target
        ? { id: c.target.id, projectId: c.target.projectId, hostId: c.target.hostId }
        : null,
    });
  }

  private hasGrant(scope: Scope, rule: PolicyRule, fingerprint: string): boolean {
    return !!this.store.db
      .prepare(`SELECT 1 FROM policy_grants WHERE scope_kind=? AND scope_id=?
      AND rule_id=? AND rule_revision=? AND fingerprint=?`)
      .get(scope.kind, scope.id, rule.id, rule.revision, fingerprint);
  }

  private rowByKey(key: string): EvaluationRow | undefined {
    return this.store.db
      .prepare("SELECT * FROM policy_evaluations WHERE evaluation_key=?")
      .get(key) as EvaluationRow | undefined;
  }
  private decision(id: string): EvaluationRow {
    const row = this.store.db
      .prepare("SELECT * FROM policy_evaluations WHERE decision_id=?")
      .get(id) as EvaluationRow | undefined;
    if (!row) throw new SwitchyardError("not_found", "Policy decision not found.");
    return row;
  }
  private ownedDecision(owner: PolicyOwner, id: string): EvaluationRow {
    const row = this.decision(id);
    const input = JSON.parse(row.input_json) as PolicyAuthorizeInput;
    const session = (
      JSON.parse(row.revisions_json) as { context: { session: PolicyContext["session"] } }
    ).context.session;
    const persistedOwner =
      input.kind === "continuation"
        ? {
            authenticatedHostId: session.hostId,
            sessionId: session.id,
            nativeSessionId: session.nativeSessionId,
            runtimeId: session.runtimeId,
          }
        : input.owner;
    if (!equal(owner, persistedOwner))
      throw new SwitchyardError("forbidden", "This policy decision belongs to another caller.");
    this.ownedSession(owner);
    if (!this.boundary(owner))
      throw new SwitchyardError("stale_control", "The policy runtime boundary is missing.");
    return row;
  }

  async status(
    owner: PolicyOwner,
    raw: PolicyStatusRequest,
    signal?: AbortSignal,
  ): Promise<PolicyStatusResult> {
    signal?.throwIfAborted();
    const request = parse(PolicyStatusRequest, raw);
    let row = this.ownedDecision(owner, request.decisionId);
    // Expired waits cannot be resurrected by a late poll; renew only a still-healthy ASK.
    this.refreshPending(row);
    row = this.decision(request.decisionId);
    if (!row.canceled && row.verdict === "ASK" && row.wait_lease_until !== null) {
      this.store.db
        .prepare("UPDATE policy_evaluations SET wait_lease_until=? WHERE evaluation_key=?")
        .run(this.nextLease(), row.evaluation_key);
    }
    if (this.needsResume(row)) {
      try {
        await this.authorize(JSON.parse(row.input_json) as PolicyAuthorizeInput);
      } catch {
        this.cancelRow(this.decision(request.decisionId), stale);
      }
    }
    this.refreshPending(this.decision(request.decisionId));
    row = this.decision(request.decisionId);
    if (!row.canceled && row.verdict === "ASK") {
      await new Promise<void>((resolve, reject) => {
        const callbacks = this.waiters.get(row.decision_id) ?? new Set<() => void>();
        const cleanup = () => {
          clearTimeout(timer);
          callbacks.delete(done);
          if (!callbacks.size && this.waiters.get(row.decision_id) === callbacks)
            this.waiters.delete(row.decision_id);
          signal?.removeEventListener("abort", abort);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason ?? new Error("Aborted"));
        };
        const timer = setTimeout(done, request.waitMs);
        callbacks.add(done);
        this.waiters.set(row.decision_id, callbacks);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    row = this.decision(request.decisionId);
    this.refreshPending(row);
    row = this.decision(request.decisionId);
    if (row.canceled) return { state: "canceled", reason: row.cancellation_reason ?? stale };
    if (row.verdict === "ASK") return { state: "pending" };
    if (row.verdict === "ALLOW") return { state: "allowed" };
    return { state: "denied", reason: (JSON.parse(row.result_json) as { reason: string }).reason };
  }

  cancel(owner: PolicyOwner, raw: PolicyCancelRequest): PolicyCancelResult {
    const request = parse(PolicyCancelRequest, raw);
    const row = this.ownedDecision(owner, request.decisionId);
    this.refreshPending(row);
    if (this.decision(row.decision_id).canceled || row.verdict === "DENY")
      return { state: "already_resolved" };
    this.cancelRow(row, "The policy action was canceled.");
    return { state: "canceled" };
  }

  /**
   * Coordinator-only discard of an unspent authorization. Match the original durable input,
   * not today's run/session/source, which may already belong to a newer settlement/controller.
   * RunsService writes the settings fence in its compare-and-discard transaction.
   */
  cancelContinuationAuthorization(input: ContinuationAuthorization, reason: string): void {
    this.store.tx(() => {
      for (const row of this.activeRows()) {
        const original = JSON.parse(row.input_json) as PolicyAuthorizeInput;
        if (
          original.kind === "continuation" &&
          original.runId === input.runId &&
          original.expectedControlRevision === input.expectedControlRevision &&
          original.nextContinuationNumber === input.nextContinuationNumber &&
          original.expectedSettleCount === input.expectedSettleCount &&
          equal(original.expectedWatermark, input.expectedWatermark)
        )
          this.cancelRow(row, reason);
      }
    });
  }

  private assertContinuationAuthorizationCurrent(input: PolicyAuthorizeInput): void {
    if (input.kind !== "continuation") return;
    const canceled = this.store.getSetting<{ reason: string; at: string } | null>(
      `runContinuationAuthorizationCanceled:${input.runId}:${input.nextContinuationNumber}:${input.expectedControlRevision}:${input.expectedSettleCount}`,
      null,
    );
    if (canceled) throw new SwitchyardError("stale_control", canceled.reason || stale);
  }

  cancelForSession(sessionId: string, runtimeId?: string): void {
    for (const row of this.activeRows()) {
      if (row.session_id !== sessionId) continue;
      const input = JSON.parse(row.input_json) as PolicyAuthorizeInput;
      if (!runtimeId || input.kind === "continuation" || input.owner.runtimeId === runtimeId)
        this.cancelRow(row, "The policy runtime exited or changed.");
    }
  }

  private pendingRows(): EvaluationRow[] {
    return this.store.db
      .prepare("SELECT * FROM policy_evaluations WHERE verdict='ASK' AND canceled=0")
      .all() as EvaluationRow[];
  }
  private activeRows(): EvaluationRow[] {
    return this.store.db
      .prepare("SELECT * FROM policy_evaluations WHERE verdict IN ('ASK','ALLOW') AND canceled=0")
      .all() as EvaluationRow[];
  }
  private needsResume(row: EvaluationRow): boolean {
    return (
      row.verdict === "ASK" &&
      !row.canceled &&
      !!row.interaction_id &&
      this.store.interactions.get(row.interaction_id)?.state === "resolved"
    );
  }
  private refreshPending(row: EvaluationRow): void {
    if (row.canceled || row.verdict === "DENY") return;
    // Revoke shared grants as well as individual decisions even if a lifecycle event was missed.
    if (row.scope_kind === "task") {
      const root = this.store.tasks.get(row.scope_id);
      const saved = (JSON.parse(row.revisions_json) as { rootStamp?: PolicyRootStamp }).rootStamp;
      if (
        !root ||
        root.parentTaskId ||
        this.terminal(root) ||
        !saved ||
        saved.id !== root.id ||
        saved.epoch !== this.rootStamp(root).epoch
      ) {
        this.store.db
          .prepare("DELETE FROM policy_grants WHERE scope_kind='task' AND scope_id=?")
          .run(row.scope_id);
        this.cancelRow(row, stale);
        return;
      }
    }
    if (this.leaseIsExpired(row)) {
      this.cancelRow(row, leaseExpired);
      return;
    }
    try {
      const input = JSON.parse(row.input_json) as PolicyAuthorizeInput;
      const pending =
        input.kind === "continuation"
          ? this.store.getSetting<PendingContinuation | null>(
              CONTINUATION_PREFIX + input.runId,
              null,
            )
          : null;
      // Reservation itself advances the count. Keep valid durable ALLOWs through ordinary
      // sweeps/restart, without treating an offline host as a permanent policy downgrade.
      const snapshot =
        input.kind === "continuation" && pending?.phase === "delivery"
          ? this.reservedContinuationSnapshot(input, pending.context)
          : this.build(input);
      if (snapshot.revisions === row.revisions_json) return;
    } catch {
      /* Missing/deleted or rebound identity is never authority. */
    }
    this.cancelRow(row, stale);
  }
  private invalidatePending(): void {
    for (const row of this.activeRows()) this.refreshPending(row);
  }
  private cancelRow(row: EvaluationRow, reason: string): void {
    this.store.tx(() => {
      this.store.db
        .prepare(
          "UPDATE policy_evaluations SET canceled=1,cancellation_reason=?,wait_lease_until=NULL,updated_at=? WHERE evaluation_key=? AND canceled=0",
        )
        .run(reason, this.store.nowIso(), row.evaluation_key);
      if (row.interaction_id) {
        const interaction = this.store.interactions.get(row.interaction_id);
        if (interaction?.state === "pending")
          this.putInteraction({
            ...interaction,
            revision: interaction.revision + 1,
            state: "canceled",
            resolution: { by: "coordinator", summary: reason, at: this.store.nowIso() },
          });
      }
    });
    this.wake(row.decision_id);
  }
  private wake(id: string): void {
    const callbacks = this.waiters.get(id);
    this.waiters.delete(id);
    for (const callback of callbacks ?? []) callback();
  }
  private putInteraction(interaction: Interaction): void {
    const session = this.store.sessions.get(interaction.sessionId);
    this.store.putInteraction(interaction, {
      hostId: session?.hostId,
      projectId: session?.projectId ?? undefined,
    });
    this.options.reconcileInputAttention(interaction);
  }

  async answer(
    decisionId: string,
    expectedInteractionRevision: number,
    confirmed: boolean,
    deviceId: string,
  ): Promise<AnswerResult> {
    const initial = this.decision(decisionId);
    return this.lock({ kind: initial.scope_kind, id: initial.scope_id }, async () => {
      this.refreshPending(this.decision(decisionId));
      const row = this.decision(decisionId);
      if (row.canceled) throw new SwitchyardError("conflict", stale);
      if (!row.interaction_id)
        throw new SwitchyardError("conflict", "This decision has no pending question.");
      const interaction = this.store.interactions.require(row.interaction_id);
      if (interaction.revision !== expectedInteractionRevision) {
        const previous = this.store.interactions
          .list("session_id = ?", [row.session_id])
          .find(
            (i) =>
              i.permission?.decisionId === decisionId &&
              i.state === "resolved" &&
              i.revision === expectedInteractionRevision + 1,
          );
        if (previous) return { status: "already_answered", interaction: previous };
        throw new SwitchyardError("conflict", stale);
      }
      if (interaction.state !== "pending" || row.verdict !== "ASK")
        return { status: "already_answered", interaction };
      const input = JSON.parse(row.input_json) as PolicyAuthorizeInput;
      let snapshot: Snapshot;
      try {
        snapshot = this.build(input);
      } catch {
        this.cancelRow(row, stale);
        throw new SwitchyardError("conflict", stale);
      }
      if (snapshot.revisions !== row.revisions_json) {
        this.cancelRow(row, stale);
        throw new SwitchyardError("conflict", stale);
      }
      const answered = this.store.tx(() => {
        const next: Interaction = {
          ...interaction,
          revision: interaction.revision + 1,
          state: "resolved",
          resolution: {
            by: deviceId,
            summary: confirmed ? "Allowed matching action" : "Denied",
            at: this.store.nowIso(),
          },
        };
        this.putInteraction(next);
        if (confirmed) {
          const permission = interaction.permission!;
          this.store.db
            .prepare(`INSERT OR IGNORE INTO policy_grants
            (id,scope_kind,scope_id,rule_id,rule_revision,fingerprint,approved_by_device_id,approved_at)
            VALUES (?,?,?,?,?,?,?,?)`)
            .run(
              `pgr_${randomUUID()}`,
              snapshot.scope.kind,
              snapshot.scope.id,
              permission.ruleId,
              permission.ruleRevision,
              permission.fingerprint,
              deviceId,
              this.store.nowIso(),
            );
        } else {
          this.commitUpdates(
            snapshot,
            JSON.parse(row.provisional_updates_json) as Record<string, PolicyCounterMap>,
          );
          this.store.db
            .prepare(
              "UPDATE policy_evaluations SET verdict='DENY',result_json=?,revisions_json=?,wait_lease_until=NULL,updated_at=? WHERE evaluation_key=?",
            )
            .run(
              json({ verdict: "DENY", reason: "The policy action was denied." }),
              this.build(input).revisions,
              this.store.nowIso(),
              row.evaluation_key,
            );
        }
        return next;
      });
      if (confirmed) {
        try {
          await this.authorizeLocked(input, true, snapshot.scope);
        } catch (error) {
          this.cancelRow(this.decision(decisionId), stale);
          throw error;
        }
      }
      this.wake(decisionId);
      return { status: "answered", interaction: answered };
    });
  }

  listRules(): PolicyRule[] {
    const rank = { session: 0, profile: 1, server: 2 };
    return (this.store.db.prepare("SELECT * FROM policy_rules").all() as RuleRow[])
      .map(fromRow)
      .sort(
        (a, b) =>
          rank[a.scope] - rank[b.scope] || a.priority - b.priority || a.id.localeCompare(b.id),
      );
  }
  getRule(id: string): PolicyRule | undefined {
    const row = this.store.db.prepare("SELECT * FROM policy_rules WHERE id=?").get(id) as
      | RuleRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }
  private requireRule(id: string): PolicyRule {
    const rule = this.getRule(id);
    if (!rule) throw new SwitchyardError("not_found", "Policy rule not found.");
    return rule;
  }
  private writeRule(rule: PolicyRule): void {
    this.store.db
      .prepare(`INSERT INTO policy_rules(id,scope,scope_id,priority,revision,enabled,phases,name,expression,built_in,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET priority=excluded.priority,
      revision=excluded.revision,enabled=excluded.enabled,phases=excluded.phases,name=excluded.name,
      expression=excluded.expression,updated_at=excluded.updated_at`)
      .run(
        rule.id,
        rule.scope,
        rule.scopeId,
        rule.priority,
        rule.revision,
        Number(rule.enabled),
        JSON.stringify(rule.phases),
        rule.name,
        rule.expression,
        Number(rule.builtIn),
        rule.createdAt,
        rule.updatedAt,
      );
  }
  private rejectUnavailablePhase(raw: unknown): void {
    if (
      raw &&
      typeof raw === "object" &&
      "phases" in raw &&
      Array.isArray(raw.phases) &&
      raw.phases.includes("model_request")
    )
      throw new SwitchyardError("invalid_request", POLICY_CAPABILITY_EXPLANATION);
  }
  private async validate(rule: PolicyRule): Promise<void> {
    const validation = await this.evaluator.validateRule(rule);
    if (!validation.valid)
      throw new SwitchyardError("invalid_request", validation.error.message, validation.error);
  }
  async createRule(raw: unknown): Promise<PolicyRule> {
    this.rejectUnavailablePhase(raw);
    const input = parse(CreatePolicyRuleRequest, raw);
    if (input.scope === "session") this.store.sessions.require(input.scopeId!);
    if (input.scope === "profile") this.store.profiles.require(input.scopeId!);
    const now = this.store.nowIso();
    const rule = PolicyRule.parse({
      ...input,
      id: `pol_${randomUUID()}`,
      revision: 1,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    });
    await this.validate(rule);
    return this.store.tx(() => {
      if (rule.scope === "session") this.store.sessions.require(rule.scopeId!);
      if (rule.scope === "profile") this.store.profiles.require(rule.scopeId!);
      this.writeRule(rule);
      this.invalidatePending();
      return rule;
    });
  }
  async updateRule(id: string, raw: unknown): Promise<PolicyRule> {
    this.rejectUnavailablePhase(raw);
    const { expectedRevision, ...patch } = parse(UpdatePolicyRuleRequest, raw);
    const previous = this.requireRule(id);
    if (previous.revision !== expectedRevision)
      throw new SwitchyardError("conflict", "Policy rule revision changed.");
    const next = PolicyRule.parse({
      ...previous,
      ...patch,
      revision: expectedRevision + 1,
      updatedAt: this.store.nowIso(),
    });
    await this.validate(next);
    return this.store.tx(() => {
      if (this.requireRule(id).revision !== expectedRevision)
        throw new SwitchyardError("conflict", "Policy rule revision changed.");
      this.writeRule(next);
      this.store.db.prepare("DELETE FROM policy_grants WHERE rule_id=?").run(id);
      this.invalidatePending();
      return next;
    });
  }
  deleteRule(id: string, expectedRevision: number): void {
    this.store.tx(() => {
      if (this.requireRule(id).revision !== expectedRevision)
        throw new SwitchyardError("conflict", "Policy rule revision changed.");
      this.store.db.prepare("DELETE FROM policy_rules WHERE id=?").run(id);
      this.invalidatePending();
    });
  }
  settings(): PolicySettings {
    const saved = this.store.getSetting<PolicySettings | null>("policySettings", null);
    if (saved) return PolicySettings.parse(saved);
    const settings: PolicySettings = {
      revision: 1,
      modelClassifications: [],
      updatedAt: this.store.nowIso(),
    };
    this.store.setSetting("policySettings", settings);
    return settings;
  }
  updateSettings(raw: UpdatePolicySettingsRequest): PolicySettings {
    const input = parse(UpdatePolicySettingsRequest, raw);
    return this.store.tx(() => {
      const previous = this.settings();
      if (previous.revision !== input.expectedRevision)
        throw new SwitchyardError("conflict", "Policy settings revision changed.");
      const next = PolicySettings.parse({
        revision: previous.revision + 1,
        modelClassifications: input.modelClassifications,
        updatedAt: this.store.nowIso(),
      });
      this.store.setSetting("policySettings", next);
      this.store.db.prepare("DELETE FROM policy_grants").run();
      this.invalidatePending();
      return next;
    });
  }

  async test(
    raw: PolicyTestRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<PolicyTestResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const request = parse(PolicyTestRequest, raw);
    const input = {
      kind: "test" as const,
      request,
      sample: undefined as HostPolicySampleResult | undefined,
    };
    const before = this.build(input);
    const reread = () => {
      try {
        return this.build(input);
      } catch {
        throw new SwitchyardError("stale_control", stale);
      }
    };
    if (request.phase === "tool_call") {
      if (!this.options.classifySample)
        throw new SwitchyardError("unsupported_capability", testUnsupported);
      const owner = before.owner!;
      const sampleRequest: HostPolicySampleRequest = {
        sessionId: owner.sessionId,
        nativeSessionId: owner.nativeSessionId,
        runtimeId: owner.runtimeId,
        sampleId: randomUUID(),
        tool: request.tool!,
      };
      const sample = parse(
        HostPolicySampleResult,
        await abortable(this.options.classifySample(sampleRequest, { signal }), signal),
      );
      signal?.throwIfAborted();
      if (
        sample.sessionId !== sampleRequest.sessionId ||
        sample.nativeSessionId !== sampleRequest.nativeSessionId ||
        sample.runtimeId !== sampleRequest.runtimeId ||
        sample.sampleId !== sampleRequest.sampleId ||
        sample.toolHash !== hash(sampleRequest.tool)
      )
        throw new SwitchyardError("forbidden", "Policy sample identity or hash mismatch.");
      // Re-read the original context, including ownership, before trusting the host's proof.
      if (reread().revisions !== before.revisions)
        throw new SwitchyardError("stale_control", stale);
      input.sample = sample;
    }
    const snapshot = this.build(input);
    if (snapshot.accountingBlocked)
      return {
        verdict: "DENY",
        reason: BUDGET_ACCOUNTING_UNAVAILABLE,
        trace: [],
        proposedStateUpdates: {},
        enforcement: this.enforcement(),
      };
    const result = await abortable(this.evaluate(snapshot, true, signal), signal);
    signal?.throwIfAborted();
    if (reread().revisions !== snapshot.revisions)
      throw new SwitchyardError("stale_control", stale);
    return result;
  }
}
