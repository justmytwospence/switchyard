import { describe, expect, it } from "vitest";
import { BridgeAgentRequest, parseBridgeRecord } from "../src/bridge-wire.js";

const frame = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  bindingId: "binding",
  context: { humanInputId: null, causalMessageId: null },
  toolCallId: "call",
  deadlineAt: "2026-11-08T00:00:00.000Z",
  method: "receipt.peek",
  args: { method: "inbox.read", args: {} },
};

describe("bridge receipt replay wire", () => {
  it("preserves binding and deadline on peek and replay", () => {
    expect(parseBridgeRecord(frame)).toEqual(frame);
    const replay = {
      ...frame,
      method: "inbox.read",
      args: {},
      receiptReplay: { requestHash: "f".repeat(64) },
    };
    expect(parseBridgeRecord(replay)).toEqual(replay);
    expect(BridgeAgentRequest.safeParse({ ...replay, bindingId: undefined }).success).toBe(false);
    expect(BridgeAgentRequest.safeParse({ ...replay, deadlineAt: "bad" }).success).toBe(false);
  });
  it("enforces peek and replay restrictions and frame size", () => {
    expect(BridgeAgentRequest.safeParse({ ...frame, toolCallId: undefined }).success).toBe(false);
    expect(
      BridgeAgentRequest.safeParse({ ...frame, receiptReplay: { requestHash: "f".repeat(64) } })
        .success,
    ).toBe(false);
    expect(() =>
      parseBridgeRecord({
        ...frame,
        args: { method: "inbox.read", args: { value: "x".repeat(128 * 1024) } },
      }),
    ).toThrow();
  });
});
