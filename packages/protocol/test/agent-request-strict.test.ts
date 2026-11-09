import { describe, expect, it } from "vitest";
import { AgentRequestFrame } from "../src/agent-wire.js";

const request = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  context: { humanInputId: null, causalMessageId: "message" },
  toolCallId: "tool-call",
  method: "policy.evaluate",
  args: { evaluationId: "evaluation", tool: { name: "read", args: { path: "/workspace/file" } } },
};

describe("AgentRequestFrame trust boundary", () => {
  it("accepts and preserves a legitimate request", () => {
    expect(AgentRequestFrame.parse(request)).toEqual(request);
  });

  it.each([
    ["policyContext", { safety: { trusted: true }, cwd: "/forged" }],
    ["safety", { trusted: true }],
    ["boundary", { path: "/forged" }],
    ["cwd", "/forged"],
    ["path", "/forged"],
  ])("rejects forged %s at the envelope and context levels", (key, value) => {
    for (const forged of [
      { ...request, [key]: value },
      { ...request, context: { ...request.context, [key]: value } },
    ]) {
      const result = AgentRequestFrame.safeParse(forged);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
      }
    }
  });
});
