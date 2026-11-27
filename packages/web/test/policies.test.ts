import { afterEach, describe, expect, it, vi } from "vitest";
import { policiesApi } from "../src/features/settings/policiesApi";
import {
  protectionLabel,
  validateRule,
  validateSettings,
  validateTest,
  verdictLabel,
} from "../src/features/settings/policyLogic";
import { compileSampleArgs, type SampleField } from "../src/features/settings/policySampleArgs";

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

describe("sample argument compilation", () => {
  const text = (key: string, value = ""): SampleField => ({ id: 1, key, kind: "text", value });
  it("preserves nested values, keys, containers and commands", () => {
    const fields: SampleField[] = [
      {
        id: 1,
        key: " metadata ",
        kind: "object",
        children: [
          {
            id: 2,
            key: "items",
            kind: "list",
            children: [
              { id: 3, key: "", kind: "number", value: "0" },
              { id: 4, key: "", kind: "boolean", value: false },
              { id: 5, key: "", kind: "null" },
              text("", " exact "),
              { id: 6, key: "", kind: "object", children: [] },
            ],
          },
        ],
      },
    ];
    expect(compileSampleArgs(fields, " cmd ")).toEqual({
      command: " cmd ",
      " metadata ": { items: [0, false, null, " exact ", {}] },
    });
    expect(compileSampleArgs([], "  ")).toEqual({});
    expect(compileSampleArgs([text("command")])).toEqual({ command: "" });
  });
  it("rejects duplicates, reserved keys, invalid numbers and excessive depth", () => {
    expect(() => compileSampleArgs([text("")])).toThrow("Argument 1 needs a name.");
    expect(() => compileSampleArgs([text("a"), text("a")])).toThrow("Duplicate field: a.");
    expect(() => compileSampleArgs([text("command")], "x")).toThrow("Duplicate field: command.");
    for (const key of ["__proto__", "prototype", "constructor"])
      expect(() => compileSampleArgs([text(key)])).toThrow(`Reserved field name: ${key}.`);
    for (const value of ["", "01", "+1", "1.", "1e999", "9007199254740992"])
      expect(() => compileSampleArgs([{ id: 1, key: "n", kind: "number", value }])).toThrow(
        "Enter a valid number for n.",
      );
    let field: SampleField = text("leaf");
    for (let i = 0; i < 20; i++)
      field = { id: i + 2, key: "nested", kind: "object", children: [field] };
    expect(() => compileSampleArgs([field])).toThrow("Sample arguments are nested too deeply.");
  });
});
