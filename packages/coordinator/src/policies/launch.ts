import { createHash } from "node:crypto";
import {
  type ContinuationPolicy,
  canonicalPolicyJson,
  type PolicyRule,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { getService } from "../services.js";
import { requireUsableHost } from "../sessions/service.js";
import { builtinPolicyRules } from "./builtins.js";

export type PolicyLaunchInput = {
  sessionId: string | null;
  profileId: string;
  continuation: ContinuationPolicy;
};
export type PolicyLaunchRequirement = {
  required: boolean;
  budgetAccountingRequired: boolean;
  ruleIds: string[];
  policyStamp: string;
};

export const POLICY_LAUNCH_UNAVAILABLE =
  "Policy enforcement needs an updated host and Pi 1.5. Existing sessions are not protected until restarted or reloaded.";

/** Static applicability only: this fence never evaluates CEL or grants authorization. */
export function policyLaunchRequirement(
  input: PolicyLaunchInput,
  rules: PolicyRule[],
  settingsRevision: number,
): PolicyLaunchRequirement {
  const applicable = rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.scope === "server" ||
          (rule.scope === "profile" && rule.scopeId === input.profileId) ||
          (rule.scope === "session" &&
            input.sessionId !== null &&
            rule.scopeId === input.sessionId)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const budgetAccountingRequired =
    input.continuation.enabled &&
    (input.continuation.maxTokens !== null || input.continuation.maxCostUsd !== null);
  const factory = builtinPolicyRules("1970-01-01T00:00:00.000Z");
  const ruleIds = applicable
    .filter((rule) => {
      if (budgetAccountingRequired) return true;
      const seeded = factory.find(
        (r) =>
          r.id === rule.id &&
          (r.id === "continuation-hard-budget" || r.id === "continuation-soft-budget"),
      );
      return !(
        seeded &&
        rule.builtIn &&
        rule.scope === "server" &&
        rule.scopeId === null &&
        rule.phases.length === 1 &&
        rule.phases[0] === "request" &&
        rule.expression === seeded.expression
      );
    })
    .map((rule) => rule.id);
  const policyStamp = createHash("sha256")
    .update(
      canonicalPolicyJson({
        ...input,
        settingsRevision,
        rules: applicable.map(({ id, revision, scope, scopeId, enabled, phases, expression }) => ({
          id,
          revision,
          scope,
          scopeId,
          enabled,
          phases,
          expression,
        })),
      }),
    )
    .digest("hex");
  return {
    required: budgetAccountingRequired || ruleIds.length > 0,
    budgetAccountingRequired,
    ruleIds,
    policyStamp,
  };
}

/** Missing/uninitialized policies are unavailable, never an empty-rules exemption. */
export function currentPolicyLaunchRequirement(
  ctx: CoordinatorContext,
  input: PolicyLaunchInput,
): PolicyLaunchRequirement {
  const policies = getService(ctx, "policies");
  if (!policies)
    throw new SwitchyardError("unsupported_capability", "Policy service is unavailable.");
  return policies.launchRequirement(input);
}

export function assertPolicyLaunchHost(
  ctx: CoordinatorContext,
  hostId: string,
  requirement: PolicyLaunchRequirement,
  existingLiveSessionId?: string,
): void {
  requireUsableHost(ctx, hostId);
  if (!requirement.required) return;
  const host = ctx.store.hosts.require(hostId);
  const features = ctx.hostHub.negotiatedFeatures(hostId);
  const fail = () => {
    throw new SwitchyardError("unsupported_capability", POLICY_LAUNCH_UNAVAILABLE);
  };
  if (
    host.capabilities?.agentRequests !== true ||
    host.capabilities.policies !== true ||
    !features.has("agentRequests.v1") ||
    !features.has("policies.v1")
  )
    fail();
  if (!existingLiveSessionId) return;
  const session = ctx.store.sessions.require(existingLiveSessionId);
  const bridge = session.bridge;
  if (
    session.hostId !== hostId ||
    session.connectivity !== "connected" ||
    bridge?.policyState !== "active" ||
    !bridge.policyPhases.includes("tool_call") ||
    !bridge.policyPhases.includes("request") ||
    !bridge.runtimeId ||
    !bridge.nativeSessionId ||
    (session.nativeHandle !== null && session.nativeHandle.sessionId !== bridge.nativeSessionId) ||
    !ctx.store.db
      .prepare(`SELECT 1 FROM policy_runtime_boundaries
      WHERE session_id=? AND native_session_id=? AND runtime_id=? AND host_id=?`)
      .get(session.id, bridge.nativeSessionId, bridge.runtimeId, hostId)
  )
    fail();
}
