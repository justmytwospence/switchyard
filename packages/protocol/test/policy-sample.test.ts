import { describe, expect, it } from "vitest";
import { CoordinatorToHost, HostCommand } from "../src/host-wire.js";
import { HostPolicySampleRequest, HostPolicySampleResult } from "../src/policies.js";

const identity = {
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  sampleId: "sample",
};
const request = { ...identity, tool: { name: "bash", args: { command: "git status" } } };
const result = {
  ...identity,
  toolHash: "a".repeat(64),
  boundary: {
    cwd: "/work/sub",
    workspaceRoot: "/work",
    cwdReal: "/real/sub",
    workspaceRootReal: "/real",
  },
  defaultBranch: "main",
  safety: {
    destructiveDelete: false,
    forcePush: false,
    defaultBranchPush: false,
    uncertain: false,
    reasons: [],
  },
};

describe("host policy sample protocol", () => {
  it("accepts strict sample requests and the correlated host command", () => {
    expect(HostPolicySampleRequest.parse(request)).toEqual(request);
    const command = { type: "session.classifyPolicySample", ...request };
    expect(HostCommand.parse(command)).toEqual(command);
    expect(CoordinatorToHost.parse({ type: "command", commandId: "id", command })).toEqual({
      type: "command",
      commandId: "id",
      command,
    });
    for (const extra of [
      { toolCallId: "call" },
      { evaluationId: "evaluation" },
      { safety: result.safety },
    ]) {
      expect(HostPolicySampleRequest.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(HostCommand.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    expect(
      HostPolicySampleRequest.safeParse({ ...request, tool: { ...request.tool, extra: true } })
        .success,
    ).toBe(false);
    for (const args of [[], null, { x: Infinity }, JSON.parse('{"__proto__":1}')]) {
      expect(
        HostPolicySampleRequest.safeParse({ ...request, tool: { name: "bash", args } }).success,
      ).toBe(false);
    }
  });

  it("uses D.2 identity, hash, boundary and safety constraints", () => {
    expect(HostPolicySampleResult.parse(result)).toEqual(result);
    for (const key of Object.keys(identity)) {
      for (const value of ["", "x".repeat(201)]) {
        expect(HostPolicySampleRequest.safeParse({ ...request, [key]: value }).success).toBe(false);
        expect(HostPolicySampleResult.safeParse({ ...result, [key]: value }).success).toBe(false);
      }
    }
    for (const bad of [
      { toolHash: "A".repeat(64) },
      { toolHash: "a".repeat(63) },
      { boundary: { ...result.boundary, cwdReal: "/outside" } },
      { boundary: { ...result.boundary, cwd: "relative" } },
      { defaultBranch: "" },
      { safety: { ...result.safety, extra: true } },
      { toolCallId: "call" },
    ])
      expect(HostPolicySampleResult.safeParse({ ...result, ...bad }).success).toBe(false);
  });
});
