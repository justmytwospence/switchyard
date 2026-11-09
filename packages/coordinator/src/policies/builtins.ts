import type { PolicyRule } from "@switchyard/protocol";

export const BUDGET_ACCOUNTING_UNAVAILABLE =
  "Budget accounting is unavailable; resume manually or remove the limit.";

export const CONTINUATION_SOFT_BUDGET_EXPRESSION =
  'action == "run.continue" && ((cost.maxTokens != null && cost.tokens != null && double(cost.tokens) >= double(cost.maxTokens) * 0.8) || (cost.maxCostUsd != null && cost.costUsd != null && double(cost.costUsd) >= double(cost.maxCostUsd) * 0.8)) ? dyn({"verdict":"ASK", "reason":"Completed usage reached 80% of the configured continuation budget."}) : null';

/** Stable IDs are inserted only when absent; startup never resets owner edits. */
export function builtinPolicyRules(now: string): PolicyRule[] {
  const common = {
    scope: "server" as const,
    scopeId: null,
    revision: 1,
    enabled: true,
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  };
  return [
    {
      ...common,
      id: "destructive-shell",
      name: "Destructive shell operations",
      phases: ["tool_call"],
      priority: -300,
      expression:
        'tool != null && (tool.safety.destructiveDelete || tool.safety.forcePush || tool.safety.defaultBranchPush || tool.safety.uncertain) ? dyn({"verdict":"ASK", "reason":"This shell operation may delete outside the workspace or push protected history."}) : null',
    },
    {
      ...common,
      id: "continuation-hard-budget",
      name: "Expensive model continuation budget",
      phases: ["request"],
      priority: -200,
      expression:
        'action == "run.continue" && cost.expensive && ((cost.maxTokens != null && cost.tokens != null && cost.tokens >= cost.maxTokens) || (cost.maxCostUsd != null && cost.costUsd != null && double(cost.costUsd) >= double(cost.maxCostUsd))) ? dyn({"verdict":"DENY", "reason":"The completed usage reached the continuation budget for an expensive or unclassified model."}) : null',
    },
    {
      ...common,
      id: "continuation-soft-budget",
      name: "Continuation budget acknowledgement",
      phases: ["request"],
      priority: -100,
      expression: CONTINUATION_SOFT_BUDGET_EXPRESSION,
    },
  ];
}
