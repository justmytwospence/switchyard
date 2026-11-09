import { existsSync } from "node:fs";
import { join } from "node:path";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeAgentRequest, BridgeFeatures } from "../src/bridge-wire.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

// Release gate for the actual installed Pi hook API, not just a permissive fake pi.on().
describe.skipIf(skipRealPi)("real Pi policy hooks", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  async function start(marker: string) {
    h.mock.setScript([
      {
        when: when.userSays("guarded"),
        reply: {
          toolCalls: [{ name: "bash", arguments: { command: `printf executed > ${marker}` } }],
        },
      },
    ]);
    const session = h.newSession({
      transport: "rpc",
      env: { ...h.env.env, SWITCHYARD_POLICY_REQUIRED: "1" },
    });
    const hello = waitFor<BridgeFeatures>(session, "bridge_features");
    await session.start();
    const features = await hello;
    expect(features.capabilities.toolPolicy).toBe(true);
    await expect(
      session.configureAgent({
        version: 1,
        sessionId: session.sessionId,
        runtimeId: features.runtimeId,
        nativeSessionId: features.nativeSessionId,
        bindingId: "policy-test",
        features: ["agentRequests.v1", "policies.v1"],
        coordinatorConnected: true,
        policyRequired: true,
        sessionUrl: "http://localhost/code/policy-test",
      }),
    ).resolves.toMatchObject({ policyState: "active", policyPhases: ["tool_call", "request"] });
    const reply = (request: BridgeAgentRequest, result: unknown) =>
      session.replyAgent({
        type: "agent.result",
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        bindingId: request.bindingId,
        ok: true,
        result,
      });
    return { session, reply, path: join(h.env.cwd, marker) };
  }

  it.each(["ALLOW", "DENY"] as const)(
    "actually awaits %s before running a built-in tool",
    async (verdict) => {
      const { session, reply, path } = await start(`policy-${verdict}`);
      try {
        const request = waitFor<BridgeAgentRequest>(session, "agent_request");
        const settled = waitFor(session, "settled");
        await session.prompt("guarded");
        const evaluation = await request;
        expect(evaluation.method).toBe("policy.evaluate");
        expect(evaluation.args).toMatchObject({
          toolCallId: evaluation.toolCallId,
          tool: { name: "bash" },
        });
        expect(existsSync(path)).toBe(false);
        reply(
          evaluation,
          verdict === "ALLOW"
            ? { verdict }
            : { verdict, reason: "Blocked by the real Pi policy gate" },
        );
        await settled;
        expect(existsSync(path)).toBe(verdict === "ALLOW");
      } finally {
        await session.stop({ graceMs: 3000, termMs: 1000 });
      }
    },
  );

  it.each(["ALLOW", "DENY", "stale_control"] as const)(
    "awaits post-ASK host proof refresh (%s) before executing the built-in tool",
    async (result) => {
      const { session, reply, path } = await start(`policy-refreshed-${result}`);
      const requests = record(session, ["agent_request"]);
      try {
        const evaluating = waitFor<BridgeAgentRequest>(
          session,
          "agent_request",
          (request) => request.method === "policy.evaluate",
        );
        await session.prompt("guarded");
        const evaluation = await evaluating;
        const polling = waitFor<BridgeAgentRequest>(
          session,
          "agent_request",
          (request) => request.method === "policy.status",
        );
        reply(evaluation, {
          verdict: "ASK",
          decisionId: "decision",
          interactionId: "interaction",
          interactionUrl: "http://localhost/code/policy-test",
        });
        const status = await polling;
        const refreshing = waitFor<BridgeAgentRequest>(
          session,
          "agent_request",
          (request) => request.method === "policy.evaluate",
        );
        reply(status, { state: "allowed" });
        const refreshed = await refreshing;
        expect(refreshed.args).toEqual(evaluation.args);
        expect(refreshed.toolCallId).toBe(evaluation.toolCallId);
        expect(existsSync(path)).toBe(false);
        const settled = waitFor(session, "settled");
        if (result === "stale_control")
          session.replyAgent({
            type: "agent.result",
            requestId: refreshed.requestId,
            runtimeId: refreshed.runtimeId,
            bindingId: refreshed.bindingId,
            ok: false,
            error: { code: "stale_control", message: "Host proof changed after approval" },
          });
        else
          reply(
            refreshed,
            result === "ALLOW"
              ? { verdict: "ALLOW" }
              : { verdict: "DENY", reason: "Host proof changed after approval" },
          );
        await settled;
        expect(existsSync(path)).toBe(result === "ALLOW");
        expect(
          requests
            .of("agent_request")
            .filter((r: BridgeAgentRequest) => r.method === "policy.evaluate"),
        ).toHaveLength(2);
      } finally {
        await session.stop({ graceMs: 3000, termMs: 1000 });
      }
    },
  );

  it("uses Pi's real streaming abort signal to cancel an approval without running the tool", async () => {
    const { session, reply, path } = await start("policy-canceled");
    const requests = record(session, ["agent_request"]);
    try {
      const evaluating = waitFor<BridgeAgentRequest>(
        session,
        "agent_request",
        (request) => request.method === "policy.evaluate",
      );
      await session.prompt("guarded");
      const evaluation = await evaluating;
      const polling = waitFor<BridgeAgentRequest>(
        session,
        "agent_request",
        (request) => request.method === "policy.status",
      );
      reply(evaluation, {
        verdict: "ASK",
        decisionId: "decision",
        interactionId: "interaction",
        interactionUrl: "http://localhost/code/policy-test",
      });
      await polling;
      expect(existsSync(path)).toBe(false);
      const canceled = waitFor<BridgeAgentRequest>(
        session,
        "agent_request",
        (request) => request.method === "policy.cancel",
      );
      const settled = waitFor(session, "settled");
      await session.abort();
      const cancellation = await canceled;
      expect(cancellation.args).toEqual({ decisionId: "decision" });
      reply(cancellation, { state: "canceled" });
      expect((await settled).aborted).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(
        requests
          .of("agent_request")
          .filter((r: BridgeAgentRequest) => r.method === "policy.cancel"),
      ).toHaveLength(1);
    } finally {
      await session.stop({ graceMs: 3000, termMs: 1000 });
    }
  });
});
