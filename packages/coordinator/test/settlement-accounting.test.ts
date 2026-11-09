import { afterEach, describe, expect, it } from "vitest";
import type { SessionSettled } from "../src/event-hub.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
} from "./helpers.js";

let coordinator: TestCoordinator | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  await host?.close();
  await coordinator?.cleanup();
  host = undefined;
  coordinator = undefined;
});

const watermark = { runtimeId: "runtime", settleSeq: 2 };
const stats = { tokens: 120, costUsd: 0.5, watermark };
async function setup() {
  coordinator = await startCoordinator();
  host = await FakeHost.connect(coordinator, await enrollHost(coordinator));
  const settled: SessionSettled[] = [];
  coordinator.c.events.on("session.settled", (event) => settled.push(event));
  return { tc: coordinator, h: host, settled };
}

describe("settlement usage projection", () => {
  it("projects completed usage and the matching settlement watermark atomically", async () => {
    const { tc, h, settled } = await setup();
    await h.event("session.updated", hostSession("session", { runtime: "running" }));
    await h.event("session.updated", {
      id: "session",
      runtime: "idle",
      stats,
      settled: { aborted: false, lastAssistantText: "Finished", watermark },
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      watermark,
      session: { stats },
      lastAssistantText: "Finished",
    });
    expect(tc.c.store.sessions.require("session").stats).toEqual(stats);
    await h.event("session.updated", { id: "session", stats });
    expect(settled).toHaveLength(1);
    expect(tc.c.store.sessions.require("session").stats?.watermark).toEqual(watermark);
    await h.event("session.updated", { id: "session", stats: { ...stats, tokens: 999 } });
    expect(tc.c.store.sessions.require("session").stats).not.toHaveProperty("watermark");
    expect(settled).toHaveLength(1);
  });

  it.each([
    ["missing", undefined],
    ["older sequence", { runtimeId: "runtime", settleSeq: 1 }],
    ["other runtime", { runtimeId: "older", settleSeq: 2 }],
    ["invalid sequence", { runtimeId: "runtime", settleSeq: 0 }],
  ])("never labels stats fresh with %s settlement evidence", async (_name, evidence) => {
    const { tc, h, settled } = await setup();
    await h.event("session.updated", hostSession("session", { runtime: "waiting_input" }));
    await h.event("session.updated", {
      id: "session",
      runtime: "idle",
      stats,
      settled: { watermark: evidence },
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).not.toHaveProperty("watermark");
    expect(settled[0]!.session.stats).toEqual({ tokens: 120, costUsd: 0.5 });
    expect(tc.c.store.sessions.require("session").stats).not.toHaveProperty("watermark");
  });

  it("clears completed-usage evidence as soon as new work starts, even on a partial update", async () => {
    const { tc, h } = await setup();
    await h.event("session.updated", hostSession("session", { runtime: "running" }));
    await h.event("session.updated", {
      id: "session",
      runtime: "idle",
      stats,
      settled: { watermark },
    });
    expect(tc.c.store.sessions.require("session").stats?.watermark).toEqual(watermark);
    await h.event("session.updated", { id: "session", runtime: "running" });
    expect(tc.c.store.sessions.require("session").stats).not.toHaveProperty("watermark");
  });

  it("does not reuse an inherited stats watermark when this update has no completed usage", async () => {
    const { h, settled } = await setup();
    await h.event("session.updated", hostSession("session", { runtime: "running", stats }));
    await h.event("session.updated", { id: "session", runtime: "idle", settled: { watermark } });
    expect(settled[0]).not.toHaveProperty("watermark");
    expect(settled[0]!.session.stats).not.toHaveProperty("watermark");
  });

  it("accepts the independent accounting epoch, not the bridge runtime UUID", async () => {
    const { h, settled } = await setup();
    await h.event(
      "session.updated",
      hostSession("session", {
        runtime: "running",
        bridge: {
          version: 1,
          runtimeId: "new-runtime",
          nativeSessionId: "native-session",
          agentTools: false,
          messageDelivery: false,
          policyState: "unsupported",
          policyPhases: [],
        },
      }),
    );
    await h.event("session.updated", {
      id: "session",
      runtime: "idle",
      stats,
      settled: { watermark },
    });
    expect(settled[0]?.watermark).toEqual(watermark);
    expect(settled[0]!.session.stats?.watermark).toEqual(watermark);
    expect(settled[0]!.session.bridge?.runtimeId).not.toBe(watermark.runtimeId);
  });

  it("ordinary stats updates cannot manufacture completed usage evidence", async () => {
    const { tc, h, settled } = await setup();
    await h.event("session.updated", hostSession("session"));
    await h.event("session.updated", { id: "session", stats });
    expect(tc.c.store.sessions.require("session").stats).not.toHaveProperty("watermark");
    expect(settled).toHaveLength(0);
    await h.event("session.updated", { id: "session", runtime: "running" });
    await h.event("session.updated", {
      id: "session",
      runtime: "idle",
      stats,
      settled: { watermark },
    });
    expect(settled).toHaveLength(1);
    await h.event("session.updated", { id: "session", stats });
    expect(tc.c.store.sessions.require("session").stats?.watermark).toEqual(watermark);
    await h.event("session.updated", {
      id: "session",
      stats: { ...stats, watermark: { ...watermark, settleSeq: 3 } },
    });
    expect(tc.c.store.sessions.require("session").stats).not.toHaveProperty("watermark");
    expect(settled).toHaveLength(1);
  });

  it("keeps old hosts settling and browsable without claiming freshness", async () => {
    const { tc, h, settled } = await setup();
    await h.event("session.updated", hostSession("session", { runtime: "running" }));
    await h.event(
      "session.updated",
      hostSession("session", {
        runtime: "idle",
        stats: { tokens: 40, costUsd: 0.2 },
        lastAssistantText: "Old host completed",
      }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ aborted: false, lastAssistantText: "Old host completed" });
    expect(settled[0]).not.toHaveProperty("watermark");
    expect(tc.c.store.sessions.require("session").stats).toEqual({ tokens: 40, costUsd: 0.2 });
    expect(tc.c.hostHub.isConnected(h.hostId)).toBe(true);
  });
});
