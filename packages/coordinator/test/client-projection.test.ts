import type { Panel, ServerToClient, SyncState, TranscriptItem } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { projectClientMessage, projectionIdFor } from "../src/client-projection.js";

const panel: Panel = {
  sessionId: "ses_1",
  adapterId: "adapter",
  slot: "@slot/check",
  title: "Check",
  node: { t: "actions", actions: [{ id: "danger", label: "Delete" }] },
  webRenderer: true,
  mobileFallback: "Check is ready",
  updatedAt: new Date().toISOString(),
  contribution: { id: "check", placement: "session.panel", actionId: "danger" },
  state: { secret: "not leaked" },
};
const notice: TranscriptItem = {
  id: "itm_1",
  sessionId: "ses_1",
  order: 1,
  at: new Date().toISOString(),
  kind: "notice",
  data: {
    level: "info",
    text: "Fallback",
    customType: "custom",
    adapterId: "adapter",
    card: { t: "text", text: "Fancy" },
  },
};
const event = (type: string, data: unknown) => ({
  seq: 3,
  id: "evt_3",
  at: new Date().toISOString(),
  type,
  data,
});
const empty = new Set<never>();

describe("client capability projection", () => {
  it("projects live and replay without losing sequence numbers or mutating stored events", () => {
    const original = {
      type: "replay",
      seq: 3,
      events: [event("panel.updated", panel), event("transcript.item", notice)],
    } as ServerToClient;
    const legacy = projectClientMessage(original, empty);
    expect(legacy.type).toBe("replay");
    if (legacy.type !== "replay") return;
    expect(legacy.events.map((e) => e.seq)).toEqual([3, 3]);
    expect(legacy.events[0]?.data).toMatchObject({
      node: { t: "text", text: "Check is ready" },
      webRenderer: false,
    });
    expect((legacy.events[0]!.data as Panel).contribution).toBeUndefined();
    expect((legacy.events[0]!.data as Panel).state).toBeUndefined();
    expect((legacy.events[1]!.data as TranscriptItem).data).toEqual({
      level: "info",
      text: "Fallback",
    });
    expect((original.events[0]!.data as Panel).contribution).toBeDefined();
    const full = projectClientMessage(original, new Set(["adapter.slots.v1", "timeline.cards.v1"]));
    expect(full).toEqual(original);
  });

  it("preserves tombstones and projects snapshot panels", () => {
    const snapshot = {
      type: "snapshot",
      seq: 3,
      state: { panels: [panel] } as SyncState,
    } as ServerToClient;
    const result = projectClientMessage(snapshot, empty);
    if (result.type !== "snapshot") throw new Error("expected snapshot");
    expect(result.state.panels[0]?.node).toEqual({ t: "text", text: "Check is ready" });
    expect((snapshot.state.panels[0] as Panel).webRenderer).toBe(true);
    const deleted = projectClientMessage(
      { type: "event", event: event("panel.updated", { ...panel, node: null }) } as ServerToClient,
      empty,
    );
    if (deleted.type !== "event") throw new Error("expected event");
    expect((deleted.event.data as Panel).node).toBeNull();
  });

  it("uses a stable projection identity for the supported set", () => {
    expect(projectionIdFor(new Set(["timeline.cards.v1", "adapter.slots.v1"]))).toBe(
      "v1:adapter.slots.v1,timeline.cards.v1",
    );
    expect(projectionIdFor(empty)).toBe("v1:");
  });
});
