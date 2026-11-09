import { describe, expect, it } from "vitest";
import {
  AgentReceiptPeekRequest,
  AgentReceiptPeekResult,
  AgentReceiptReplay,
  AgentRequestFrame,
} from "../src/agent-wire.js";
import { HostAgentRequestFrame, HostToCoordinator } from "../src/host-wire.js";

const hash = "a".repeat(64);
const frame = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  context: { humanInputId: null, causalMessageId: null },
  toolCallId: "call",
  deadlineAt: "2026-11-08T00:00:00.000Z",
  method: "receipt.peek",
  args: { method: "task.create", args: { objective: "hello", nested: [true, null] } },
};

describe("receipt replay wire", () => {
  it("strictly validates lookup, result, and replay records", () => {
    expect(AgentReceiptPeekRequest.parse(frame.args)).toEqual(frame.args);
    expect(AgentReceiptPeekRequest.safeParse({ ...frame.args, extra: true }).success).toBe(false);
    expect(AgentReceiptPeekRequest.safeParse({ method: "policy.evaluate", args: {} }).success).toBe(
      false,
    );
    expect(AgentReceiptPeekRequest.safeParse({ method: "task.create", args: [] }).success).toBe(
      false,
    );
    expect(AgentReceiptPeekResult.parse({ found: false })).toEqual({ found: false });
    expect(AgentReceiptPeekResult.parse({ found: true, requestHash: hash })).toEqual({
      found: true,
      requestHash: hash,
    });
    for (const value of [
      { found: false, requestHash: hash },
      { found: true, requestHash: hash.toUpperCase() },
      { found: true },
    ]) {
      expect(AgentReceiptPeekResult.safeParse(value).success).toBe(false);
    }
    expect(AgentReceiptReplay.safeParse({ requestHash: hash, extra: true }).success).toBe(false);
    expect(AgentReceiptReplay.safeParse({ requestHash: "a".repeat(63) }).success).toBe(false);
  });
  it("preserves peek and requires its call id on both host frames", () => {
    for (const schema of [AgentRequestFrame, HostAgentRequestFrame, HostToCoordinator]) {
      expect(schema.parse(frame)).toEqual(frame);
      expect(schema.safeParse({ ...frame, toolCallId: undefined }).success).toBe(false);
    }
  });
  it("accepts replay only on the three tool methods", () => {
    for (const method of ["task.create", "message.send", "inbox.read"]) {
      const replay = { ...frame, method, args: {}, receiptReplay: { requestHash: hash } };
      expect(AgentRequestFrame.parse(replay)).toEqual(replay);
      expect(HostAgentRequestFrame.parse(replay)).toEqual(replay);
    }
    for (const method of [
      "session.bind",
      "receipt.peek",
      "policy.evaluate",
      "policy.status",
      "policy.cancel",
    ]) {
      const replay = {
        ...frame,
        method,
        receiptReplay: { requestHash: hash },
        ...(method === "policy.evaluate" ? { policyContext: {} } : {}),
      };
      expect(AgentRequestFrame.safeParse(replay).success).toBe(false);
      expect(HostAgentRequestFrame.safeParse(replay).success).toBe(false);
    }
  });
});
