import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AgentMethod,
  AgentRequestFrame,
  AgentResultFrame,
  AgentToolPolicyWait,
} from "../src/index.js";

const deadlineAt = "2026-11-08T12:00:30.000Z";
const request = {
  type: "agent.request",
  requestId: "request",
  sessionId: "session",
  nativeSessionId: "native",
  runtimeId: "runtime",
  context: { humanInputId: "human", causalMessageId: null },
  toolCallId: "tool-call",
  method: "task.create",
  args: { objective: "Do the work" },
} as const;
const wait = {
  type: "policy.required",
  decisionId: "decision",
  interactionId: "interaction",
  interactionUrl: "https://switchyard.example/interactions/interaction",
} as const;

describe("AgentToolPolicyWait", () => {
  it("exports a strict typed nonfinal result without changing successful result shapes", () => {
    expectTypeOf<AgentToolPolicyWait>().toEqualTypeOf<{
      type: "policy.required";
      decisionId: string;
      interactionId: string;
      interactionUrl: string;
    }>();
    expect(AgentToolPolicyWait.parse(wait)).toEqual(wait);
    for (const result of [wait, { taskId: "task" }, { messageId: "message" }]) {
      const frame = {
        type: "agent.result",
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        ok: true,
        result,
      };
      expect(AgentResultFrame.parse(frame)).toEqual(frame);
    }
  });

  it.each(["type", "decisionId", "interactionId", "interactionUrl"])("requires %s", (field) => {
    const missing: Record<string, unknown> = { ...wait };
    delete missing[field];
    expect(AgentToolPolicyWait.safeParse(missing).success).toBe(false);
  });

  it.each([
    { type: "ASK" },
    { decisionId: "" },
    { decisionId: "x".repeat(201) },
    { interactionId: "" },
    { interactionId: "x".repeat(201) },
    { interactionUrl: "" },
    { interactionUrl: "/interactions/interaction" },
    { interactionUrl: "javascript:alert(1)" },
    { interactionUrl: "https://user:password@switchyard.example/interaction" },
    { verdict: "ALLOW" },
    { taskId: "task" },
    { policyContext: { safety: { trusted: true } } },
  ])("rejects malformed or additional fields: %j", (fields) => {
    expect(AgentToolPolicyWait.safeParse({ ...wait, ...fields }).success).toBe(false);
  });
});

describe("AgentRequestFrame deadline compatibility", () => {
  it("keeps the inferred deadline optional without widening trusted context", () => {
    expectTypeOf<AgentRequestFrame["deadlineAt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AgentRequestFrame["context"]>().toEqualTypeOf<{
      humanInputId: string | null;
      causalMessageId: string | null;
    }>();
  });

  it.each(AgentMethod.options)(
    "preserves deadlines but does not globally require them for %s",
    (method) => {
      const frame = { ...request, method };
      expect(AgentRequestFrame.parse(frame)).toEqual(frame);
      expect(AgentRequestFrame.parse({ ...frame, deadlineAt })).toEqual({ ...frame, deadlineAt });
    },
  );

  it.each([
    null,
    123,
    "",
    "not-a-date",
    "2026-11-08",
    "2026-11-08T12:00:30Z",
    "2026-11-08T12:00:30.000+00:00",
    "2026-11-08T13:00:30.000+01:00",
    "2026-02-30T12:00:30.000Z",
  ])("rejects noncanonical deadlines: %j", (value) => {
    expect(AgentRequestFrame.safeParse({ ...request, deadlineAt: value }).success).toBe(false);
  });

  it("validates syntax, not expiry, and preserves strict trust metadata with a deadline", () => {
    // Ingress must still allow expired final-receipt replays; freshness is not a schema concern.
    expect(
      AgentRequestFrame.parse({ ...request, deadlineAt: "2000-01-01T00:00:00.000Z" }).deadlineAt,
    ).toBe("2000-01-01T00:00:00.000Z");
    for (const fields of [
      { hostId: "forged-host" },
      { policyContext: { safety: { trusted: true } } },
      { context: { ...request.context, deadlineAt } },
      { context: { ...request.context, safety: { trusted: true } } },
    ]) {
      expect(AgentRequestFrame.safeParse({ ...request, deadlineAt, ...fields }).success).toBe(
        false,
      );
    }
  });
});
