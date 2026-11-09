import type { PolicyContext, PolicyRule } from "@switchyard/protocol";

export function policyRule(
  expression = '{"verdict":"ALLOW","reason":""}',
  overrides: Partial<PolicyRule> = {},
): PolicyRule {
  return {
    id: "rule",
    revision: 1,
    scope: "server",
    scopeId: null,
    priority: 0,
    enabled: true,
    phases: ["tool_call", "request"],
    name: "Test rule",
    expression,
    builtIn: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function policyContext(): Omit<PolicyContext, "counters"> {
  return {
    phase: "tool_call",
    action: "tool.call",
    tool: {
      name: "bash",
      args: {},
      safety: {
        destructiveDelete: false,
        forcePush: false,
        defaultBranchPush: false,
        uncertain: false,
        reasons: [],
      },
    },
    request: null,
    session: {
      id: "session",
      hostId: "host",
      nativeSessionId: null,
      runtimeId: null,
      profileId: "profile",
      projectId: null,
      taskId: null,
      runId: null,
      controlMode: "human",
      controlRevision: 1,
      cwd: "/repo",
      workspaceRoot: "/repo",
      repository: null,
      defaultBranch: null,
      readOnly: false,
    },
    task: null,
    target: null,
    cost: {
      tokens: 10,
      costUsd: 1,
      maxTokens: 100,
      maxCostUsd: 2,
      accounting: "available",
      fresh: true,
      watermark: { runtimeId: "runtime", settleSeq: 1 },
      provider: null,
      modelId: null,
      classification: "unclassified",
      expensive: true,
    },
  };
}
