import { createHash } from "node:crypto";
import {
  CompletedUsageWatermark,
  canonicalPolicyJson,
  type Run,
  type Session,
} from "@switchyard/protocol";
import type { PolicyAuthorizeInput } from "../policies/contracts.js";
import type { PolicyService } from "../policies/service.js";
import type { Store } from "../store.js";

export type ContinuationSettlement = {
  count: number;
  watermark: CompletedUsageWatermark | null;
};

export type ContinuationAuthorization = Extract<PolicyAuthorizeInput, { kind: "continuation" }>;

export type ContinuationSource = {
  runtimeId: string;
  nativeSessionId: string;
  controllerEpoch: string;
};

/** Never reconstruct historical controller proof from a native file or today's binding. */
export function continuationSource(session: Session | undefined): ContinuationSource | null {
  const bridge = session?.bridge;
  if (!bridge?.runtimeId || !bridge.nativeSessionId || !bridge.controllerEpoch) return null;
  return {
    runtimeId: bridge.runtimeId,
    nativeSessionId: bridge.nativeSessionId,
    controllerEpoch: bridge.controllerEpoch,
  };
}

/** A reserved delivery is already counted; an authorization (including ASK) is not. */
export interface PendingContinuation {
  version: 3;
  source: ContinuationSource;
  phase: "authorization" | "delivery";
  deliveryAttempt: "not_sent" | "may_have_sent";
  input: ContinuationAuthorization;
  context: string;
  n: number;
  text: string;
  decisionId: string | null;
}

export const CONTINUATION_PREFIX = "runContinuation:";
export const CANCELED_CONTINUATION_PREFIX = "runContinuationCanceled:";
export const CANCELED_AUTHORIZATION_PREFIX = "runContinuationAuthorizationCanceled:";

/** Older recognized formats may prove non-delivery, but never gain execution authority. */
export function isUnspentContinuationAuthorization(
  run: Run | undefined,
  runId: string,
  pending: PendingContinuation,
): boolean {
  return (
    !!run &&
    run.id === runId &&
    [1, 2, 3].includes(pending.version) &&
    pending.phase === "authorization" &&
    pending.deliveryAttempt === "not_sent" &&
    pending.input?.kind === "continuation" &&
    pending.input.runId === runId &&
    Number.isSafeInteger(pending.n) &&
    pending.n > 0 &&
    pending.n === pending.input.nextContinuationNumber &&
    Number.isSafeInteger(pending.input.expectedControlRevision) &&
    pending.input.expectedControlRevision >= 0 &&
    Number.isSafeInteger(pending.input.expectedSettleCount) &&
    pending.input.expectedSettleCount >= 0 &&
    (pending.input.expectedWatermark === null ||
      CompletedUsageWatermark.safeParse(pending.input.expectedWatermark).success) &&
    run.continuationsUsed === pending.n - 1
  );
}
export const CONTINUATION_PAUSED_NOTICE =
  "Continuation authorization changed; automation is paused for review.";
export const CONTINUATION_UNCERTAIN_NOTICE =
  "The previous send may already have reached Pi; it was not resent.";
export const SETTLEMENT_PREFIX = "runContinuationSettlement:";

/**
 * Local execution fences supplement PolicyService's authoritative authorization. Keep these
 * across ASK/restart, including identity and configuration changes that do not advance a settle.
 * Do not compare the accounting epoch with the unrelated bridge runtime id.
 */
export function continuationContext(store: Store, policies: PolicyService, run: Run): string {
  const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
  const task = store.tasks.get(run.taskId);
  const workspace = session?.workspaceId ? store.workspaces.get(session.workspaceId) : undefined;
  const ancestry = [];
  const seen = new Set<string>();
  let ancestor = task;
  while (ancestor && !seen.has(ancestor.id)) {
    seen.add(ancestor.id);
    ancestry.push({
      id: ancestor.id,
      title: ancestor.title,
      projectId: ancestor.projectId,
      parentTaskId: ancestor.parentTaskId ?? null,
      state: ancestor.state,
      policy: ancestor.policy,
    });
    ancestor = ancestor.parentTaskId ? store.tasks.get(ancestor.parentTaskId) : undefined;
  }
  const snapshot = canonicalPolicyJson({
    attempt: run.attempt,
    hostId: run.hostId,
    sessionId: run.sessionId,
    controlRevision: run.controlRevision,
    controlMode: run.controlMode,
    limits: run.limits,
    currentRunId: task?.currentRunId ?? null,
    ancestry,
    root: policies.rootFence(run.taskId),
    session: session
      ? {
          hostId: session.hostId,
          taskId: session.taskId,
          runId: session.runId,
          source: {
            version: session.bridge?.version ?? null,
            runtimeId: session.bridge?.runtimeId ?? null,
            nativeSessionId: session.bridge?.nativeSessionId ?? null,
            controllerEpoch: session.bridge?.controllerEpoch ?? null,
          },
          model: session.model ?? null,
          stats: session.stats,
          projectId: session.projectId,
          repository: session.projectId
            ? (store.projects.get(session.projectId)?.repoIdentity ?? null)
            : null,
          profileSnapshot: session.profileSnapshot,
          cwd: session.cwd,
          workspaceId: session.workspaceId,
          workspace: workspace
            ? { path: workspace.path, hostId: workspace.hostId, projectId: workspace.projectId }
            : null,
          readOnly: session.readOnly,
          archivedAt: session.archivedAt,
        }
      : null,
    rules: policies
      .listRules()
      .filter(
        (rule) =>
          rule.enabled &&
          rule.phases.includes("request") &&
          (rule.scope === "server" ||
            (rule.scope === "session" && rule.scopeId === session?.id) ||
            (rule.scope === "profile" && rule.scopeId === session?.profileSnapshot.id)),
      ),
    settings: policies.settings(),
  });
  return createHash("sha256").update(snapshot).digest("hex");
}

export function matchesContinuation(
  store: Store,
  policies: PolicyService,
  run: Run,
  pending: PendingContinuation,
): boolean {
  const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
  const expected = pending.input;
  const watermark = session?.stats?.watermark ?? null;
  return (
    pending.version === 3 &&
    !!pending.source &&
    canonicalPolicyJson(continuationSource(session)) === canonicalPolicyJson(pending.source) &&
    pending.input.runId === run.id &&
    pending.n === expected.nextContinuationNumber &&
    (pending.phase === "authorization" || pending.phase === "delivery") &&
    (pending.deliveryAttempt === "not_sent" || pending.deliveryAttempt === "may_have_sent") &&
    store.tasks.get(run.taskId)?.currentRunId === run.id &&
    session?.runId === run.id &&
    session.taskId === run.taskId &&
    session.hostId === run.hostId &&
    !!session.bridge?.runtimeId &&
    !!session.bridge.nativeSessionId &&
    !!session.bridge.controllerEpoch &&
    (!session.nativeHandle || session.nativeHandle.sessionId === session.bridge.nativeSessionId) &&
    run.state === "running" &&
    run.controlMode === "automation" &&
    run.controlRevision === expected.expectedControlRevision &&
    run.continuationsUsed === pending.n - (pending.phase === "authorization" ? 1 : 0) &&
    store.runSettleCount(run.id) === expected.expectedSettleCount &&
    session?.runtime === "idle" &&
    !session.compacting &&
    (expected.expectedWatermark === null ||
      canonicalPolicyJson(watermark) === canonicalPolicyJson(expected.expectedWatermark)) &&
    continuationContext(store, policies, run) === pending.context
  );
}
