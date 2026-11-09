import { AgentMethod, AgentRequestFrame, AgentToolPolicyWait } from "@switchyard/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BridgeAgentRequest,
  BridgeAgentResult,
  parseBridgeRecord,
  validateAgentResult,
} from "../src/bridge-wire.js";

const deadlineAt = "2026-11-08T12:00:30.000Z";
const request = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  bindingId: "binding",
  context: { humanInputId: "human", causalMessageId: null },
  toolCallId: "tool-call",
  method: "task.create",
  args: { objective: "Do the work" },
} as const;

describe("bridge request deadline schema parity", () => {
  it("inherits the optional deadline and exact trust-context types", () => {
    expectTypeOf<BridgeAgentRequest["deadlineAt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<BridgeAgentRequest["context"]>().toEqualTypeOf<AgentRequestFrame["context"]>();
    expectTypeOf<BridgeAgentRequest["bindingId"]>().toEqualTypeOf<string>();
  });

  it.each(AgentMethod.options)(
    "preserves serialized deadlines and legacy requests for %s",
    (method) => {
      for (const fields of [{}, { deadlineAt }]) {
        const frame = { ...request, method, ...fields };
        const parsed = BridgeAgentRequest.parse(JSON.parse(JSON.stringify(frame)));
        expect(parsed).toEqual(frame);
        expect(parseBridgeRecord(frame)).toEqual(frame);
        const { bindingId, ...upstream } = parsed;
        expect(bindingId).toBe(request.bindingId);
        expect(AgentRequestFrame.parse(upstream)).toEqual(upstream);
      }
    },
  );

  it.each([
    null,
    123,
    "",
    "invalid",
    "2026-11-08T12:00:30Z",
    "2026-11-08T12:00:30.000+00:00",
    "2026-02-30T12:00:30.000Z",
  ])("rejects invalid or noncanonical deadlines at the socket reader: %j", (value) => {
    const frame = { ...request, deadlineAt: value };
    expect(BridgeAgentRequest.safeParse(frame).success).toBe(false);
    expect(() => parseBridgeRecord(frame)).toThrow();
  });

  it("retains binding and trust fences when the deadline is present", () => {
    for (const fields of [
      { bindingId: "" },
      { bindingId: "x".repeat(201) },
      { nativeSessionId: "" },
      { runtimeId: "" },
      { hostId: "forged-host" },
      { policyContext: { safety: { trusted: true } } },
      { context: { ...request.context, deadlineAt } },
      { context: { ...request.context, safety: { trusted: true } } },
    ]) {
      expect(BridgeAgentRequest.safeParse({ ...request, deadlineAt, ...fields }).success).toBe(
        false,
      );
    }
  });
});

describe("bridge nonfinal tool-policy result", () => {
  it("carries the wait result unchanged through the binding-fenced response", () => {
    const wait = AgentToolPolicyWait.parse({
      type: "policy.required",
      decisionId: "decision",
      interactionId: "interaction",
      interactionUrl: "https://switchyard.example/interactions/interaction",
    });
    const frame = {
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result: wait,
    } as const;
    const parsed = validateAgentResult(JSON.parse(JSON.stringify(frame)));
    expect(parsed).toEqual(frame);
    expect(AgentToolPolicyWait.parse(parsed.ok ? parsed.result : null)).toEqual(wait);
    expect(BridgeAgentResult.safeParse({ ...frame, bindingId: "" }).success).toBe(false);
  });
});
