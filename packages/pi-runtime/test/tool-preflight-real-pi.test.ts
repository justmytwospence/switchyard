import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeAgentRequest, BridgeFeatures } from "../src/bridge-wire.js";
import type { ManagedSession } from "../src/session-runtime.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

// Actual Pi exercises the awaited hook, JSON-schema adapter and native-file restart. The
// coordinator is a deliberately small receipt responder here; its SQLite/restart gate lives
// in coordinator integration tests, not this dependency-free bridge regression.
describe.skipIf(skipRealPi)("real Pi receipt preflight", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  async function configure(session: ManagedSession, bindingId: string) {
    const hello = waitFor<BridgeFeatures>(session, "bridge_features");
    await session.start();
    const features = await hello;
    await session.configureAgent({
      version: 1,
      sessionId: session.sessionId,
      runtimeId: features.runtimeId,
      nativeSessionId: features.nativeSessionId,
      bindingId,
      features: ["agentRequests.v1", "policies.v1"],
      coordinatorConnected: true,
      policyRequired: true,
      sessionUrl: "http://localhost/code/receipt-test",
    });
    return features;
  }
  function reply(session: ManagedSession, request: BridgeAgentRequest, result: unknown) {
    session.replyAgent({
      type: "agent.result",
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      bindingId: request.bindingId,
      ok: true,
      result,
    });
  }
  function script(id: string) {
    h.mock.setScript([
      {
        when: when.userSays("receipt work"),
        reply: {
          toolCalls: [
            { name: "switchyard_create_task", id, arguments: { objective: "original task" } },
          ],
        },
      },
    ]);
  }

  it("re-emits a committed call after lost acknowledgement under a new runtime/controller without evaluating again", async () => {
    script("stable_receipt_call");
    const first = h.newSession({
      transport: "rpc",
      env: { ...h.env.env, SWITCHYARD_POLICY_REQUIRED: "1" },
    });
    const initialFeatures = await configure(first, "first-controller");
    const peeking = waitFor<BridgeAgentRequest>(first, "agent_request");
    await first.prompt("receipt work");
    const peek = await peeking;
    expect(peek.method).toBe("receipt.peek");
    const evaluating = waitFor<BridgeAgentRequest>(first, "agent_request");
    reply(first, peek, { found: false });
    const evaluation = await evaluating;
    expect(evaluation.method).toBe("policy.evaluate");
    const creating = waitFor<BridgeAgentRequest>(first, "agent_request");
    reply(first, evaluation, { verdict: "ALLOW" });
    const creation = await creating;
    expect(creation.method).toBe("task.create");
    expect(creation).not.toHaveProperty("receiptReplay");
    // Commit, deliberately lose acknowledgement, and stop RPC Pi. No retry is acknowledged.
    const stored = { taskId: "one-task", title: "original task" };
    const requestHash = createHash("sha256").update(JSON.stringify(creation.args)).digest("hex");
    const handle = first.nativeHandle!;
    await first.stop({ graceMs: 1000, termMs: 1000 });

    script("stable_receipt_call");
    const resumed = h.newSession({
      sessionId: first.sessionId,
      nativeHandle: handle,
      transport: "rpc",
      env: { ...h.env.env, SWITCHYARD_POLICY_REQUIRED: "1" },
    });
    const requests = record(resumed, ["agent_request"]);
    try {
      const nextFeatures = await configure(resumed, "replacement-controller");
      expect(nextFeatures.runtimeId).not.toBe(initialFeatures.runtimeId);
      expect(nextFeatures.nativeSessionId).toBe(initialFeatures.nativeSessionId);
      const peekingAgain = waitFor<BridgeAgentRequest>(resumed, "agent_request");
      const settled = waitFor(resumed, "settled");
      await resumed.prompt("receipt work again");
      const nextPeek = await peekingAgain;
      expect(nextPeek.method).toBe("receipt.peek");
      expect(nextPeek.toolCallId).toBe(creation.toolCallId);
      expect(nextPeek.args).toEqual({ method: "task.create", args: creation.args });
      const replaying = waitFor<BridgeAgentRequest>(resumed, "agent_request");
      reply(resumed, nextPeek, { found: true, requestHash });
      const replay = await replaying;
      expect(replay.method).toBe("task.create");
      expect(replay.receiptReplay).toEqual({ requestHash });
      expect(replay.args).toEqual(creation.args);
      reply(resumed, replay, stored);
      await settled;
      expect(requests.of("agent_request").map((r) => r.method)).toEqual([
        "receipt.peek",
        "task.create",
      ]);
      const modelResult = h.mock.requests.findLast(
        (r) => r.lastToolName === "switchyard_create_task",
      );
      expect(modelResult?.lastText).toBe(JSON.stringify(stored));
    } finally {
      await resumed.stop({ graceMs: 1000, termMs: 1000 });
    }
  });

  it("a duplicate logical id ends before original execute without deleting its receipt-only handoff", async () => {
    h.mock.setScript([
      {
        when: when.userSays("duplicate receipt"),
        reply: {
          toolCalls: ["duplicate_receipt_call", "duplicate_receipt_second"].map((id) => ({
            name: "switchyard_create_task",
            id,
            arguments: { objective: "original task" },
          })),
        },
      },
    ]);
    // The OpenAI streaming parser coalesces duplicate provider IDs. Use a trusted test
    // extension's supported message_end replacement to present the duplicate to real Pi's
    // tool preparation/execution loop instead; no production hook or adapter is mocked.
    const extension = join(h.env.cwd, "duplicate-id.ts");
    writeFileSync(
      extension,
      `export default function (pi) {
      pi.on("message_end", (event) => {
        const message = event.message;
        if (message.role !== "assistant" || !message.content.some((c) => c.id === "duplicate_receipt_second")) return;
        return { message: { ...message, content: message.content.map((c) =>
          c.id === "duplicate_receipt_second" ? { ...c, id: "duplicate_receipt_call" } : c
        ) } };
      });
    }`,
    );
    const session = h.newSession({
      transport: "rpc",
      extensions: [extension],
      env: { ...h.env.env, SWITCHYARD_POLICY_REQUIRED: "1" },
    });
    const events = record(session, ["agent_request", "pi_event"]);
    try {
      await configure(session, "duplicate-controller");
      const peeking = waitFor<BridgeAgentRequest>(session, "agent_request");
      const settled = waitFor(session, "settled");
      await session.prompt("duplicate receipt");
      const peek = await peeking;
      expect(peek.method).toBe("receipt.peek");
      // Pi prepares all parallel calls first. The first hook arms its handoff, then the
      // duplicate is blocked and emits an ambiguous end BEFORE the first adapter executes.
      const duplicateEnd = waitFor(
        session,
        "pi_event",
        (event) => event.type === "tool_execution_end" && event.isError === true,
      );
      const replaying = waitFor<BridgeAgentRequest>(session, "agent_request");
      reply(session, peek, { found: true, requestHash: "c".repeat(64) });
      const ended = await duplicateEnd;
      expect(ended.toolCallId).toBe("duplicate_receipt_call");
      expect(ended.result.content).toEqual([
        { type: "text", text: "Tool preflight is already active" },
      ]);
      expect(ended.result.terminate).not.toBe(true);
      const replay = await replaying;
      expect(replay.method).toBe("task.create");
      expect(replay.receiptReplay).toEqual({ requestHash: "c".repeat(64) });
      expect(replay.toolCallId).toBe(peek.toolCallId);
      expect(replay.args).toEqual(peek.args.args);
      const endIndex = events.log.findIndex(
        (e) => e.event === "pi_event" && e.value.type === "tool_execution_end" && e.value.isError,
      );
      const replayIndex = events.log.findIndex(
        (e) => e.event === "agent_request" && e.value.requestId === replay.requestId,
      );
      expect(endIndex).toBeGreaterThanOrEqual(0);
      expect(replayIndex).toBeGreaterThan(endIndex);
      reply(session, replay, { taskId: "one-recorded-task" });
      await settled;
      expect(events.of("agent_request").map((r) => r.method)).toEqual([
        "receipt.peek",
        "task.create",
      ]);
      const ends = events.of("pi_event").filter((e) => e.type === "tool_execution_end");
      expect(ends).toHaveLength(2);
      expect(ends[1].isError).toBe(false);
      expect(ends[1].result.details).toEqual({ taskId: "one-recorded-task" });
    } finally {
      await session.stop({ graceMs: 1000, termMs: 1000 });
    }
  });

  it("does not execute a protected adapter when its receipt disappears after the actual hook", async () => {
    script("deleted_receipt_call");
    const session = h.newSession({
      transport: "rpc",
      env: { ...h.env.env, SWITCHYARD_POLICY_REQUIRED: "1" },
    });
    const requests = record(session, ["agent_request"]);
    try {
      await configure(session, "deleted-controller");
      const peeking = waitFor<BridgeAgentRequest>(session, "agent_request");
      const settled = waitFor(session, "settled");
      await session.prompt("receipt work deleted");
      const peek = await peeking;
      expect(peek.method).toBe("receipt.peek");
      const replaying = waitFor<BridgeAgentRequest>(session, "agent_request");
      reply(session, peek, { found: true, requestHash: "b".repeat(64) });
      const replay = await replaying;
      expect(replay.receiptReplay).toEqual({ requestHash: "b".repeat(64) });
      const message = "The recorded tool result is no longer available; no action was executed.";
      session.replyAgent({
        type: "agent.result",
        requestId: replay.requestId,
        runtimeId: replay.runtimeId,
        bindingId: replay.bindingId,
        ok: false,
        error: { code: "conflict", message },
      });
      await settled;
      expect(requests.of("agent_request").map((r) => r.method)).toEqual([
        "receipt.peek",
        "task.create",
      ]);
      expect(h.mock.requests.at(-1)?.lastText).toContain(message);
    } finally {
      await session.stop({ graceMs: 1000, termMs: 1000 });
    }
  });
});
