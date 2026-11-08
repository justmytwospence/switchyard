import { readFileSync } from "node:fs";
import { type CoordinatorToHost, HostToCoordinator } from "@switchyard/protocol";
import { skipRealPi, when } from "@switchyard/test-fixtures";
import { describe, expect, it } from "vitest";
import { startCommand, startHarness, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("live host broker and delivery integration", () => {
  it("reattaches a terminal holder without inferring protection from installed support", async () => {
    const h = await startHarness({ terminalSessions: true });
    try {
      const id = "ses_live_terminal_rebind";
      await h.coord.ok(startCommand(id, h.pi!.cwd));
      await h.agent.stop();
      const next = await h.restartAgent();
      await waitFor(
        () => next.supervisor.isLive(id) && next.supervisor.record(id)?.runtime === "idle",
        10000,
        "terminal reattachment",
      );
      await waitFor(
        () => next.supervisor.record(id)?.bridge?.policyState === "unsupported",
        10000,
        "disabled legacy-coordinator configuration",
      );
      expect({
        live: next.supervisor.isLive(id),
        record: next.supervisor.record(id),
      }).toMatchObject({
        live: true,
        record: {
          runtime: "idle",
          terminal: { socketPath: expect.any(String) },
          bridge: { policyState: "unsupported", agentTools: false, messageDelivery: false },
        },
      });
    } finally {
      await h.dispose();
    }
  }, 40000);
  it("configures the actual RPC bridge, records human ids, and reconciles a native delivery entry", async () => {
    const h = await startHarness({
      script: [{ when: when.userSays("hello"), reply: { text: "hi" } }],
    });
    try {
      const send = h.coord.send.bind(h.coord);
      const listening = new WeakSet<object>();
      h.coord.send = (frame: CoordinatorToHost) => {
        if (frame.type === "welcome") {
          const ws = h.coord.socket!;
          if (!listening.has(ws)) {
            listening.add(ws);
            ws.on("message", (raw) => {
              const request = HostToCoordinator.parse(JSON.parse(raw.toString()));
              if (request.type !== "agent.request") return;
              if (request.method !== "session.bind")
                throw new Error(`Unexpected agent method ${request.method}`);
              send({
                type: "agent.result",
                requestId: request.requestId,
                runtimeId: request.runtimeId,
                ok: true,
                result: {
                  version: 1,
                  sessionId: request.sessionId,
                  runtimeId: request.runtimeId,
                  nativeSessionId: request.nativeSessionId,
                  features: ["agentRequests.v1"],
                  policyRequired: false,
                  sessionUrl: null,
                },
              });
            });
          }
          send({ ...frame, features: ["agentRequests.v1"] });
        } else send(frame);
      };
      h.coord.socket!.close();
      await waitFor(
        () => h.agent.link.negotiatedFeatures.has("agentRequests.v1"),
        10000,
        "feature negotiation",
      );
      const id = "ses_live_bridge";
      await h.coord.ok(startCommand(id, h.pi!.cwd));
      await waitFor(
        () => h.agent.supervisor.record(id)?.bridge?.messageDelivery === true,
        10000,
        "bridge configure receipt",
      );
      expect(h.agent.supervisor.record(id)?.bridge).toMatchObject({
        agentTools: true,
        messageDelivery: true,
        policyState: "unsupported",
      });
      const before = Date.now();
      await h.coord.ok({
        type: "session.prompt",
        sessionId: id,
        text: "hello",
        images: [],
        mode: "prompt",
        origin: "human",
        controlRevision: 1,
      });
      await h.coord.waitEvent(
        (e) =>
          e.type === "session.updated" &&
          e.sessionId === id &&
          e.data.settled != null &&
          Date.parse(e.at) >= before,
      );
      const nativeFile = h.agent.supervisor.record(id)!.nativeHandle!.sessionFile;
      const entries = () =>
        readFileSync(nativeFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      expect(
        entries().filter((e) => e.type === "custom" && e.customType === "switchyard-human-input"),
      ).toEqual([
        expect.objectContaining({
          data: { version: 1, humanInputId: expect.stringMatching(/^[a-f0-9-]{36}$/) },
        }),
      ]);
      const messageId = "msg_live_delivery";
      expect(
        await h.coord.command({
          type: "session.deliverMessage",
          sessionId: id,
          messageId,
          payload: {
            deliveryId: messageId,
            kind: "message",
            text: "A message is available in your inbox.",
          },
          mode: "queue",
          holdUntil: new Date(Date.now() + 600000).toISOString(),
        }),
      ).toMatchObject({ ok: true, result: { state: "accepted" } });
      await waitFor(
        () =>
          entries().some(
            (e) =>
              e.type === "custom_message" &&
              e.customType === "switchyard-inbox" &&
              e.details?.deliveryId === messageId,
          ),
        10000,
        "native delivery entry",
      );
      await waitFor(
        () =>
          h.agent.db.get<{ state: string }>(
            "SELECT state FROM message_receipts WHERE message_id = ?",
            [messageId],
          )?.state === "appended",
        10000,
        "durable append reconciliation",
      );
      expect(
        await h.coord.ok({ type: "session.messageStatus", sessionId: id, messageIds: [messageId] }),
      ).toMatchObject({ messages: [{ messageId, state: "appended" }] });
      expect(entries().filter((e) => e.customType === "switchyard-human-input")).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  }, 40000);
});
