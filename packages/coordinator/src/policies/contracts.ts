import type {
  AgentRequestFrame,
  CompletedUsageWatermark,
  HostToolPolicyContext,
  PolicyRuleResult,
  Task,
} from "@switchyard/protocol";

export type PolicyOwner = {
  authenticatedHostId: string;
  sessionId: string;
  nativeSessionId: string;
  runtimeId: string;
};

/** Authoritative lifecycle fence; epochs survive terminal -> reopen cycles. */
export type PolicyRootStamp = {
  id: string;
  state: Task["state"];
  updatedAt: string;
  epoch: number;
};

export type PolicyAuthorizeInput =
  | {
      kind: "tool";
      owner: PolicyOwner;
      frame: AgentRequestFrame;
      hostContext: HostToolPolicyContext;
      signal?: AbortSignal;
    }
  | {
      kind: "agent_request";
      owner: PolicyOwner;
      frame: AgentRequestFrame;
      signal?: AbortSignal;
    }
  | {
      kind: "continuation";
      runId: string;
      expectedControlRevision: number;
      nextContinuationNumber: number;
      expectedSettleCount: number;
      expectedWatermark: CompletedUsageWatermark | null;
      signal?: AbortSignal;
    };

/** Stable authority is valid; availability alone decides whether delivery can proceed. */
export type ReservedContinuationReadiness = { state: "ready" } | { state: "defer"; reason: string };

export type PolicyEngineError = {
  kind: "parse" | "type" | "runtime" | "limit" | "timeout" | "worker";
  message: string;
  range: { start: number; end: number } | null;
};

export type Validation =
  | { valid: true; returnType: string }
  | { valid: false; error: PolicyEngineError };

export type EvaluatedRule =
  | {
      ruleId: string;
      ruleRevision: number;
      result: PolicyRuleResult;
      error: null;
    }
  | {
      ruleId: string;
      ruleRevision: number;
      result: null;
      error: PolicyEngineError;
    };
