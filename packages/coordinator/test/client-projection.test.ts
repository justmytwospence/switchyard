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
    const full = projectClientMessage(
      original,
      new Set(["adapter.slots.v1", "timeline.cards.v1", "scopes.v1"]),
    );
    expect(full).toEqual(original);
  });

  it("preserves tombstones and projects snapshot panels", () => {
    const snapshot = {
      type: "snapshot",
      seq: 3,
      state: { panels: [panel], scopes: [], clients: [] } as unknown as SyncState,
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

  describe("scopes and clients (COMPAT(scopes-rename))", () => {
    const scope = {
      id: "trk_1",
      name: "work",
      mode: "all",
      projectIds: ["prj_1"],
      hostIds: null,
      sessionIds: ["ses_1"],
      source: {
        kind: "github",
        hostId: "hst_1",
        owner: "acme",
        repositories: null,
        board: null,
        writeBack: false,
        moveShared: true,
        enabled: true,
        login: "me",
        lastSyncedAt: null,
        lastError: null,
      },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    };
    const manual = { ...scope, id: "viw_2", name: "scratch", source: null };
    const client = {
      id: "herdr:work@mac",
      kind: "herdr",
      name: "work",
      machine: "mac",
      deviceId: "dev_1",
      hostId: null,
      mirror: "scope",
      scopeId: "trk_1",
      bindingSetAt: "2026-01-01",
      shows: ["ses_1"],
      lastSeenAt: "2026-01-02",
      createdAt: "2026-01-01",
    };
    const snapshot = {
      type: "snapshot",
      seq: 3,
      state: { panels: [], scopes: [scope, manual], clients: [client], issues: [] },
    } as unknown as ServerToClient;
    const events = {
      type: "replay",
      seq: 6,
      events: [
        event("scope.updated", scope),
        event("scope.deleted", { id: "viw_2" }),
        event("client.updated", { ...client, mirror: "all", scopeId: null }),
        event("client.deleted", { id: client.id }),
        event("session.updated", { id: "ses_1" }),
      ],
    } as ServerToClient;

    it("without scopes.v1 a snapshot carries views and terminals, and scope and client events are renamed", () => {
      const old = projectClientMessage(snapshot, new Set(["adapter.slots.v1"]));
      if (old.type !== "snapshot") throw new Error("expected snapshot");
      const state = old.state as unknown as Record<string, any>;
      expect("scopes" in state).toBe(false);
      expect("clients" in state).toBe(false);
      expect(state.views).toEqual([
        {
          id: "trk_1",
          name: "work",
          mode: "all",
          projectIds: ["prj_1"],
          hostIds: null,
          sessionIds: ["ses_1"],
          clients: [],
          trackerId: "trk_1",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-02",
        },
        expect.objectContaining({ id: "viw_2", trackerId: null }),
      ]);
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0]).toMatchObject({ id: client.id, mirror: "view", viewId: "trk_1" });
      expect("scopeId" in state.terminals[0]).toBe(false);

      const replay = projectClientMessage(events, empty);
      if (replay.type !== "replay") throw new Error("expected replay");
      expect(replay.events.map((e) => e.type)).toEqual([
        "view.updated",
        "view.deleted",
        "terminal.updated",
        "terminal.deleted",
        "session.updated",
      ]);
      expect(replay.events.map((e) => e.seq)).toEqual([3, 3, 3, 3, 3]);
      expect(replay.events[0]!.data).toMatchObject({ id: "trk_1", trackerId: "trk_1" });
      expect(replay.events[1]!.data).toEqual({ id: "viw_2" });
      expect(replay.events[2]!.data).toMatchObject({ mirror: "all", viewId: null });
      const live = projectClientMessage(
        { type: "event", event: event("client.updated", client) } as ServerToClient,
        empty,
      );
      if (live.type !== "event") throw new Error("expected event");
      expect(live.event).toMatchObject({ type: "terminal.updated", data: { viewId: "trk_1" } });
    });

    it("with scopes.v1 messages pass through", () => {
      const all = new Set(["adapter.slots.v1", "timeline.cards.v1", "scopes.v1"] as const);
      expect(projectClientMessage(snapshot, all)).toEqual(snapshot);
      expect(projectClientMessage(events, all)).toEqual(events);
      expect(projectionIdFor(all)).toBe("v1:adapter.slots.v1,scopes.v1,timeline.cards.v1");
    });
  });
});
