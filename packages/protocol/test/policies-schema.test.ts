import { describe, expect, it } from "vitest";
import {
  PolicyContext,
  PolicyCounterMap,
  PolicyEvaluation,
  PolicyRule,
  PolicySettings,
  PolicyTestRequest,
} from "../src/policies.js";

const now = "2026-01-01T00:00:00.000Z";
const context = {
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
    id: "s",
    hostId: "h",
    nativeSessionId: null,
    runtimeId: null,
    profileId: "p",
    projectId: null,
    taskId: null,
    runId: null,
    controlMode: "human",
    controlRevision: 1,
    cwd: "/tmp",
    workspaceRoot: "/tmp",
    repository: null,
    defaultBranch: null,
    readOnly: false,
  },
  task: null,
  target: null,
  cost: {
    tokens: null,
    costUsd: null,
    maxTokens: null,
    maxCostUsd: null,
    accounting: "unavailable",
    fresh: false,
    watermark: null,
    provider: null,
    modelId: null,
    classification: "unclassified",
    expensive: true,
  },
  counters: {},
};
describe("policy schemas", () => {
  it("requires nulls, consistent phase, bounded safe JSON and no caller extras", () => {
    expect(PolicyContext.safeParse(context).success).toBe(true);
    expect(PolicyContext.safeParse({ ...context, task: undefined }).success).toBe(false);
    expect(PolicyContext.safeParse({ ...context, phase: "request" }).success).toBe(false);
    expect(
      PolicyContext.safeParse({
        ...context,
        cost: { ...context.cost, classification: "cheap", expensive: false },
      }).success,
    ).toBe(false);
    expect(
      PolicyContext.safeParse({
        ...context,
        cost: {
          ...context.cost,
          provider: "p",
          modelId: "m",
          classification: "cheap",
          expensive: false,
        },
      }).success,
    ).toBe(true);
    expect(
      PolicyContext.safeParse({
        ...context,
        tool: { ...context.tool, args: JSON.parse('{"constructor":1}') },
      }).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      PolicyContext.safeParse({ ...context, tool: { ...context.tool, args: cyclic } }).success,
    ).toBe(false);
    expect(
      PolicyContext.safeParse({
        ...context,
        tool: { ...context.tool, args: { huge: "x".repeat(65536) } },
      }).success,
    ).toBe(false);
    expect(
      PolicyTestRequest.safeParse({
        sessionId: "s",
        phase: "tool_call",
        tool: { name: "bash", args: {} },
        request: null,
        session: {},
      }).success,
    ).toBe(false);
  });
  it("validates scope, counters, model uniqueness and exact replies", () => {
    const rule = {
      id: "r",
      scope: "server",
      scopeId: null,
      priority: 0,
      revision: 1,
      enabled: true,
      phases: ["request"],
      name: "r",
      expression: "null",
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    expect(PolicyRule.safeParse(rule).success).toBe(true);
    expect(PolicyRule.safeParse({ ...rule, scopeId: "x" }).success).toBe(false);
    expect(PolicyRule.safeParse({ ...rule, phases: ["model_request"] }).success).toBe(false);
    expect(PolicyCounterMap.safeParse({ count: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    const item = { provider: "p", modelId: "m", classification: "cheap" };
    expect(
      PolicySettings.safeParse({ revision: 1, modelClassifications: [item, item], updatedAt: now })
        .success,
    ).toBe(false);
    expect(
      PolicyEvaluation.safeParse({
        verdict: "ASK",
        decisionId: "d",
        interactionId: "i",
        interactionUrl: "http://localhost/code",
      }).success,
    ).toBe(true);
    expect(PolicyEvaluation.safeParse({ verdict: "ALLOW", reason: "x" }).success).toBe(false);
  });
});
