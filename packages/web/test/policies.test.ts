import { afterEach, describe, expect, it, vi } from "vitest";
import { policiesApi } from "../src/features/settings/policiesApi";
import {
  protectionLabel,
  validateRule,
  validateSettings,
  validateTest,
  verdictLabel,
} from "../src/features/settings/policyLogic";

afterEach(() => vi.unstubAllGlobals());

describe("policy surfaces", () => {
  const rule = {
    scope: "server",
    scopeId: null,
    priority: 0,
    enabled: true,
    phases: ["tool_call"],
    name: "Safety",
    expression: "null",
  };
  it("validates rule fields, phases and scopes", () => {
    expect(validateRule(rule).success).toBe(true);
    expect(validateRule({ ...rule, scope: "profile", scopeId: null }).success).toBe(false);
    expect(validateRule({ ...rule, scope: "session", scopeId: "s" }).success).toBe(true);
    expect(validateRule({ ...rule, phases: ["model_request"] }).success).toBe(false);
    expect(validateRule({ ...rule, name: "" }).success).toBe(false);
  });
  it("requires revisions and unique model classifications", () => {
    const model = { provider: "p", modelId: "m", classification: "cheap" };
    expect(validateSettings({ expectedRevision: 1, modelClassifications: [model] }).success).toBe(
      true,
    );
    expect(validateSettings({ expectedRevision: 0, modelClassifications: [model] }).success).toBe(
      false,
    );
    expect(
      validateSettings({ expectedRevision: 1, modelClassifications: [model, model] }).success,
    ).toBe(false);
  });
  it("preserves revisions and reports conflicts without overwriting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "conflict", message: "Revision changed" } }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      policiesApi.update("rule/1", { expectedRevision: 3, enabled: false }),
    ).rejects.toMatchObject({ code: "conflict", message: "Revision changed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/policies/rule%2F1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      expectedRevision: 3,
      enabled: false,
    });
  });
  it("returns tester traces without mutation requests", async () => {
    const result = {
      verdict: "ASK",
      reason: "Review",
      trace: [],
      proposedStateUpdates: {},
      enforcement: { phases: ["request"], modelRequest: false, explanation: "Not enforced" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      policiesApi.test({
        sessionId: "s",
        phase: "request",
        tool: null,
        request: { method: "run.continue", args: {} },
      }),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/policies/test");
  });
  it("validates tests and labels results without advertising model enforcement", () => {
    expect(
      validateTest({
        sessionId: "s",
        phase: "request",
        tool: null,
        request: { method: "run.continue", args: {} },
      }).success,
    ).toBe(true);
    expect(
      validateTest({ sessionId: "s", phase: "request", tool: null, request: null }).success,
    ).toBe(false);
    expect(verdictLabel("ASK")).toBe("Ask");
    expect(protectionLabel({})).toContain("Not enforced");
    expect(
      protectionLabel({
        bridge: {
          version: 1,
          runtimeId: "r",
          nativeSessionId: "n",
          agentTools: true,
          messageDelivery: true,
          policyState: "active",
          policyPhases: ["tool_call"],
        },
      }),
    ).toBe("Active: Tool call");
  });
});
