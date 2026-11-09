import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_FRAME_MAX_BYTES, AgentRequestFrame } from "../src/agent-wire.js";
import { SessionStats } from "../src/entities.js";
import { HostAgentRequestFrame, HostToCoordinator } from "../src/host-wire.js";
import {
  CompletedUsageWatermark,
  canonicalPolicyJson,
  HostPolicyBoundary,
  HostToolPolicyContext,
  type JsonValue,
  PolicyCostContext,
  PolicyEvaluateRequest,
} from "../src/policies.js";

const safety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [],
};
const boundary = {
  cwd: "/launch/link/subdir",
  workspaceRoot: "/launch/link",
  cwdReal: "/real/workspace/subdir",
  workspaceRootReal: "/real/workspace",
};
const tool = { name: "bash", args: { command: "git status" } };
const policyContext = {
  version: 1,
  toolCallId: "call",
  toolHash: createHash("sha256").update(canonicalPolicyJson(tool)).digest("hex"),
  boundary,
  defaultBranch: null,
  safety,
};
const evaluation = { evaluationId: "evaluation", toolCallId: "call", tool };
const baseFrame = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "bridge-epoch",
  context: { humanInputId: null, causalMessageId: null },
  toolCallId: "call",
  method: "policy.evaluate",
  args: evaluation,
};
const hostFrame = { ...baseFrame, policyContext };
const canonical = (value: unknown) => canonicalPolicyJson(value as JsonValue);
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("shared completed usage watermark", () => {
  it("requires a bounded accounting identity and a positive safe settle sequence", () => {
    const watermark = { runtimeId: "accounting-epoch-not-the-bridge-id", settleSeq: 1 };
    expect(CompletedUsageWatermark.parse(watermark)).toEqual(watermark);
    expect(
      CompletedUsageWatermark.parse({ ...watermark, settleSeq: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ ...watermark, settleSeq: Number.MAX_SAFE_INTEGER });
    for (const runtimeId of ["", "x".repeat(201), null, undefined]) {
      expect(CompletedUsageWatermark.safeParse({ ...watermark, runtimeId }).success).toBe(false);
    }
    for (const settleSeq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"]) {
      expect(CompletedUsageWatermark.safeParse({ ...watermark, settleSeq }).success).toBe(false);
    }
    expect(CompletedUsageWatermark.safeParse({ runtimeId: "epoch" }).success).toBe(false);
    expect(CompletedUsageWatermark.safeParse({ ...watermark, extra: true }).success).toBe(false);
  });

  it("uses the same strict schema for policy cost and session stats watermarks", () => {
    expect(SessionStats.shape.watermark.unwrap()).toBe(CompletedUsageWatermark);
    const cost = {
      tokens: 1,
      costUsd: null,
      maxTokens: null,
      maxCostUsd: null,
      accounting: "available",
      fresh: true,
      watermark: { runtimeId: "accounting-epoch", settleSeq: 1 },
      provider: null,
      modelId: null,
      classification: "unclassified",
      expensive: true,
    };
    expect(PolicyCostContext.parse(cost).watermark).toEqual(cost.watermark);
    expect(
      PolicyCostContext.safeParse({ ...cost, watermark: { ...cost.watermark, extra: true } })
        .success,
    ).toBe(false);
  });
});

describe("host policy boundary", () => {
  it("normalizes POSIX dot, repeated and trailing separators without resolving symlinks", () => {
    expect(
      HostPolicyBoundary.parse({
        cwd: "/launch//link/./subdir/../subdir/",
        workspaceRoot: "/launch/link/.",
        cwdReal: "/real//workspace/subdir/.",
        workspaceRootReal: "/real/workspace/",
      }),
    ).toEqual(boundary);
    // Raw paths remain distinct from the separately attested realpaths.
    expect(HostPolicyBoundary.parse(boundary).cwd).toBe("/launch/link/subdir");
    expect(HostPolicyBoundary.parse({ ...boundary, cwdReal: "/real/workspace/./" }).cwdReal).toBe(
      "/real/workspace",
    );
    expect(
      HostPolicyBoundary.parse({ ...boundary, workspaceRootReal: "/" }).workspaceRootReal,
    ).toBe("/");
  });

  it.each(Object.keys(boundary) as (keyof typeof boundary)[])(
    "requires a bounded absolute NUL-free POSIX %s",
    (key) => {
      const missing: Partial<typeof boundary> = { ...boundary };
      delete missing[key];
      expect(HostPolicyBoundary.safeParse(missing).success).toBe(false);
      for (const path of [
        "",
        "relative",
        "C:\\workspace",
        "/real/\0workspace",
        `/${"x".repeat(8192)}`,
      ]) {
        expect(HostPolicyBoundary.safeParse({ ...boundary, [key]: path }).success).toBe(false);
      }
    },
  );

  it("accepts the exact path bound and rejects unknown fields", () => {
    const path = `/${"x".repeat(8191)}`;
    expect(
      HostPolicyBoundary.safeParse({
        cwd: path,
        workspaceRoot: path,
        cwdReal: path,
        workspaceRootReal: path,
      }).success,
    ).toBe(true);
    expect(HostPolicyBoundary.safeParse({ ...boundary, safety }).success).toBe(false);
  });

  it.each([
    "/real/workspace-sibling/file",
    "/real/workspaces/file",
    "/real/workspace/../outside",
    "/real",
    "/",
    "/elsewhere/workspace",
  ])("rejects non-contained real cwd %s, not just a textual prefix", (cwdReal) => {
    expect(HostPolicyBoundary.safeParse({ ...boundary, cwdReal }).success).toBe(false);
  });

  it("checks containment after normalizing both sides", () => {
    expect(
      HostPolicyBoundary.safeParse({
        ...boundary,
        cwdReal: "/real/workspace/subdir/..",
        workspaceRootReal: "/real/workspace/../workspace/",
      }).success,
    ).toBe(true);
    expect(
      HostPolicyBoundary.safeParse({
        ...boundary,
        workspaceRootReal: "/real/workspace/subdir/other",
      }).success,
    ).toBe(false);
  });
});

describe("host-only tool policy context", () => {
  it("requires every field, including a nullable unknown default branch", () => {
    expect(HostToolPolicyContext.parse(policyContext)).toEqual(policyContext);
    expect(
      HostToolPolicyContext.parse({ ...policyContext, defaultBranch: "trunk" }).defaultBranch,
    ).toBe("trunk");
    for (const key of Object.keys(policyContext)) {
      const missing: Record<string, unknown> = { ...policyContext };
      delete missing[key];
      expect(HostToolPolicyContext.safeParse(missing).success).toBe(false);
    }
    expect(HostToolPolicyContext.safeParse({ ...policyContext, extra: true }).success).toBe(false);
    expect(
      HostToolPolicyContext.safeParse({ ...policyContext, safety: { ...safety, trusted: true } })
        .success,
    ).toBe(false);
  });

  it("requires version 1, bounded IDs and lowercase SHA256 hex", () => {
    for (const toolHash of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
      expect(HostToolPolicyContext.safeParse({ ...policyContext, toolHash }).success).toBe(false);
    }
    expect(HostToolPolicyContext.safeParse({ ...policyContext, version: 2 }).success).toBe(false);
    expect(HostToolPolicyContext.safeParse({ ...policyContext, toolCallId: "" }).success).toBe(
      false,
    );
    expect(
      HostToolPolicyContext.safeParse({ ...policyContext, toolCallId: "x".repeat(201) }).success,
    ).toBe(false);
    for (const defaultBranch of ["", "x".repeat(256)]) {
      expect(HostToolPolicyContext.safeParse({ ...policyContext, defaultBranch }).success).toBe(
        false,
      );
    }
  });
});

describe("canonicalPolicyJson", () => {
  it("sorts every object's keys lexicographically, including integer-looking keys", () => {
    const value = { z: { c: 1, a: 2 }, "2": "two", "10": "ten", a: [3, { y: true, b: null }] };
    const expected = '{"10":"ten","2":"two","a":[3,{"b":null,"y":true}],"z":{"a":2,"c":1}}';
    expect(canonical(value)).toBe(expected);
    expect(canonical({ a: value.a, "10": "ten", "2": "two", z: { a: 2, c: 1 } })).toBe(expected);
    expect(canonical([2, 1])).toBe("[2,1]");
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it("uses JSON leaf encoding and accepts null-prototype records and repeated references", () => {
    const text = 'unicode: 雪; quote: "; slash: \\; newline: \n; surrogate: \ud800';
    expect(canonical([null, true, false, 1.25, -0, text])).toBe(
      `[null,true,false,1.25,0,${JSON.stringify(text)}]`,
    );
    const shared = Object.assign(Object.create(null), { z: "last", a: "first" });
    expect(canonical({ b: shared, a: shared })).toBe(
      '{"a":{"a":"first","z":"last"},"b":{"a":"first","z":"last"}}',
    );
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    1n,
    () => true,
    Symbol("unsafe"),
    new Date(),
    new Map(),
    new Set(),
    new Number(1),
    { nested: undefined },
    { nested: { bad: NaN } },
    JSON.parse('{"nested":{"__proto__":{}}}'),
    JSON.parse('{"prototype":1}'),
    JSON.parse('{"constructor":1}'),
    Object.create({ inherited: true }),
    [undefined],
    Array(2),
    Object.assign([1], { extra: 2 }),
    Object.assign(Array(1), { extra: 2 }),
    { [Symbol("hidden")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
  ])("rejects non-JSON or unsafe input %#", (value) => {
    expect(() => canonical(value)).toThrow(TypeError);
    expect(
      PolicyEvaluateRequest.safeParse({ ...evaluation, tool: { name: "bash", args: { value } } })
        .success,
    ).toBe(false);
  });

  it("rejects cycles, excessive nesting and accessors without executing user code", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonical(cycle)).toThrow(TypeError);
    let nested: JsonValue = null;
    for (let i = 0; i < 20; i++) nested = [nested];
    expect(() => canonical(nested)).not.toThrow();
    expect(() => canonical([nested])).toThrow(TypeError);
    let accessed = false;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        accessed = true;
        return "not JSON data";
      },
    });
    expect(() => canonical(accessor)).toThrow(TypeError);
    expect(accessed).toBe(false);
  });

  it("hashes the complete structured tool arguments consistently", () => {
    const command = "x".repeat(16000);
    const hash = (value: JsonValue) =>
      createHash("sha256").update(canonicalPolicyJson(value)).digest("hex");
    expect(hash({ name: "bash", args: { timeout: 3, command } })).toBe(
      hash({ args: { command, timeout: 3 }, name: "bash" }),
    );
    expect(hash({ name: "bash", args: { command } })).not.toBe(
      hash({ name: "bash", args: { command: `${command}y` } }),
    );
  });
});

describe("authenticated host agent request envelope", () => {
  it("preserves host attestation only on the authenticated host schema", () => {
    expect(HostAgentRequestFrame.parse(hostFrame)).toEqual(hostFrame);
    expect(HostToCoordinator.parse(hostFrame)).toEqual(hostFrame);
    expect(Object.keys(AgentRequestFrame.shape)).not.toContain("policyContext");
    expect(Object.keys(PolicyEvaluateRequest.shape).sort()).toEqual([
      "evaluationId",
      "tool",
      "toolCallId",
    ]);
  });

  it("requires host policy context iff method is policy.evaluate", () => {
    expect(HostAgentRequestFrame.safeParse(baseFrame).success).toBe(false);
    expect(HostToCoordinator.safeParse(baseFrame).success).toBe(false);
    for (const method of [
      "session.bind",
      "task.create",
      "message.send",
      "inbox.read",
      "policy.status",
      "policy.cancel",
    ]) {
      expect(HostAgentRequestFrame.safeParse({ ...baseFrame, method }).success).toBe(true);
      expect(HostAgentRequestFrame.safeParse({ ...hostFrame, method }).success).toBe(false);
      expect(HostToCoordinator.safeParse({ ...hostFrame, method }).success).toBe(false);
      expect(
        HostAgentRequestFrame.safeParse({ ...baseFrame, method, policyContext: undefined }).success,
      ).toBe(false);
    }
    expect(HostAgentRequestFrame.safeParse({ ...hostFrame, policyContext: null }).success).toBe(
      false,
    );
  });

  it("keeps Pi evaluation arguments strict and rejects forged safety/path/context fields", () => {
    expect(PolicyEvaluateRequest.parse(evaluation)).toEqual(evaluation);
    for (const extra of [{ policyContext }, { safety }, { boundary }, { cwd: "/forged" }]) {
      expect(PolicyEvaluateRequest.safeParse({ ...evaluation, ...extra }).success).toBe(false);
      expect(HostAgentRequestFrame.safeParse({ ...hostFrame, ...extra }).success).toBe(
        Object.hasOwn(extra, "policyContext"),
      );
    }
    expect(
      PolicyEvaluateRequest.safeParse({ ...evaluation, tool: { ...tool, safety } }).success,
    ).toBe(false);
  });

  it("bounds the fully enriched UTF-8 JSON, including exact-limit acceptance", () => {
    const empty = { ...hostFrame, args: { data: "" } };
    const atLimit = {
      ...empty,
      args: { data: "x".repeat(AGENT_FRAME_MAX_BYTES - byteLength(empty)) },
    };
    expect(byteLength(atLimit)).toBe(AGENT_FRAME_MAX_BYTES);
    expect(HostAgentRequestFrame.safeParse(atLimit).success).toBe(true);
    expect(HostToCoordinator.safeParse(atLimit).success).toBe(true);
    const overLimit = { ...atLimit, args: { data: `${atLimit.args.data}x` } };
    const { policyContext: _context, ...unenriched } = overLimit;
    expect(byteLength(unenriched)).toBeLessThan(AGENT_FRAME_MAX_BYTES);
    expect(HostAgentRequestFrame.safeParse(overLimit).success).toBe(false);
    expect(HostToCoordinator.safeParse(overLimit).success).toBe(false);
    expect(
      HostAgentRequestFrame.safeParse({
        ...empty,
        args: { data: "雪".repeat(AGENT_FRAME_MAX_BYTES / 2) },
      }).success,
    ).toBe(false);
    expect(
      HostAgentRequestFrame.safeParse({
        ...empty,
        args: { data: "\0".repeat(AGENT_FRAME_MAX_BYTES / 2) },
      }).success,
    ).toBe(false);
  });

  it("rejects unserializable envelopes without throwing from safeParse", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const args of [cycle, { bigint: 1n }]) {
      expect(HostAgentRequestFrame.safeParse({ ...hostFrame, args }).success).toBe(false);
    }
  });
});
