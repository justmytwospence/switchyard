// @module-tag slow
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollDevice,
  enrollHost,
  FakeClient,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  tempDir,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

function addProfile(tc: TestCoordinator, name: string) {
  return tc.admin("POST", "/api/profiles", { name });
}

describe("client sync", () => {
  it("negotiates optional client capabilities and resets on projection changes", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    const c = await FakeClient.connect(t, { token: dev.credential });
    const cursor = t.c.store.currentSeq();
    c.send({
      type: "hello",
      cursor,
      capabilities: ["adapter.slots.v1", "unknown"],
      projectionId: null,
    });
    const first = await c.inbox.waitFor((m) => m.type === "snapshot");
    expect(first).toMatchObject({
      type: "snapshot",
      projectionId: "v1:adapter.slots.v1",
      capabilities: ["adapter.slots.v1"],
    });
    c.send({
      type: "hello",
      cursor,
      capabilities: ["adapter.slots.v1"],
      projectionId: "v1:adapter.slots.v1",
    });
    const second = await c.inbox.waitFor((m) => m.type === "replay");
    expect(second).toMatchObject({
      type: "replay",
      events: [],
      projectionId: "v1:adapter.slots.v1",
    });
    const from = c.inbox.messages.length;
    c.send({ type: "hello", cursor, capabilities: [], projectionId: "v1:adapter.slots.v1" });
    const downgrade = await c.inbox.waitFor((m) => m.type === "snapshot", 5000, from);
    expect(downgrade).toMatchObject({ type: "snapshot", projectionId: "v1:", capabilities: [] });
    c.close();
  });

  it("keeps only the latest journal event of a panel", async () => {
    t = await startCoordinator();
    const host = await FakeHost.connect(t, await enrollHost(t));
    await host.event("session.updated", hostSession("ses_tick", { runtime: "idle" }));
    const panel = (slot: string, text: string | null) => ({
      sessionId: "ses_tick",
      adapterId: "generic",
      slot,
      title: "Status",
      node: text === null ? null : { t: "text", text },
      mobileFallback: null,
      webRenderer: false,
      updatedAt: new Date().toISOString(),
    });
    for (const text of ["cache 3", "cache 2", "cache 1"])
      await host.event("panel.updated", panel("status", text));
    await host.event("panel.updated", panel("other", "x"));
    const journal = () =>
      (
        t.c.store.st
          .get("SELECT json FROM events WHERE type = 'panel.updated' ORDER BY seq")
          .all() as { json: string }[]
      ).map((r) => {
        const p = JSON.parse(r.json) as { slot: string; node: { text: string } | null };
        return [p.slot, p.node?.text ?? null];
      });
    expect(journal()).toEqual([
      ["status", "cache 1"],
      ["other", "x"],
    ]);
    // Removing a panel replaces its event with the tombstone.
    await host.event("panel.updated", panel("status", null));
    expect(journal()).toEqual([
      ["other", "x"],
      ["status", null],
    ]);
  });

  it("projects contributed panels and cards independently for old and new clients", async () => {
    t = await startCoordinator();
    const hostCreds = await enrollHost(t);
    const host = await FakeHost.connect(t, hostCreds);
    await host.event("session.updated", hostSession("ses_slots", { runtime: "idle" }));
    const dev = await enrollDevice(t);
    const old = await FakeClient.connect(t, { token: dev.credential });
    const modern = await FakeClient.connect(t, { token: dev.credential });
    await old.hello(null);
    modern.send({
      type: "hello",
      cursor: null,
      capabilities: ["adapter.slots.v1", "timeline.cards.v1"],
      projectionId: null,
    });
    await modern.inbox.waitFor((m) => m.type === "snapshot");
    const panel = {
      sessionId: "ses_slots",
      adapterId: "sample",
      slot: "@slot/check",
      title: "Check",
      node: { t: "text", text: "Rich" },
      mobileFallback: "Plain fallback",
      webRenderer: false,
      updatedAt: new Date().toISOString(),
      contribution: { id: "check", placement: "session.panel" },
    };
    const fromOld = old.inbox.messages.length;
    const fromNew = modern.inbox.messages.length;
    await host.event("panel.updated", panel);
    const oldEvent = await old.inbox.waitFor(
      (m) => m.type === "event" && m.event.type === "panel.updated",
      5000,
      fromOld,
    );
    const modernEvent = await modern.inbox.waitFor(
      (m) => m.type === "event" && m.event.type === "panel.updated",
      5000,
      fromNew,
    );
    if (oldEvent.type !== "event" || modernEvent.type !== "event")
      throw new Error("expected events");
    expect(oldEvent.event.seq).toBe(modernEvent.event.seq);
    expect(oldEvent.event.data).toMatchObject({ node: { t: "text", text: "Plain fallback" } });
    expect(oldEvent.event.data).not.toHaveProperty("contribution");
    expect(modernEvent.event.data).toMatchObject({
      contribution: { id: "check" },
      node: { t: "text", text: "Rich" },
    });
    const replay = await old.hello(oldEvent.event.seq - 1);
    if (replay.type !== "replay") throw new Error("expected replay");
    expect(replay.events.at(-1)?.data).not.toHaveProperty("contribution");
    old.close();
    modern.close();
    await host.close();
  });

  it("sends a snapshot for a null cursor, with the seeded Default profile", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    const c = await FakeClient.connect(t, { token: dev.credential });
    const m = await c.hello(null);
    expect(m.type).toBe("snapshot");
    if (m.type !== "snapshot") return;
    expect(m.seq).toBe(t.c.store.currentSeq());
    expect(m.state.profiles.map((p) => p.name)).toEqual(["Default", "Vanilla"]);
    expect(m.state.devices.map((d) => d.id)).toEqual([dev.deviceId]);
    expect(m.state.dispatchPaused).toBe(false);
    c.close();
  });

  it("replays events after a retained cursor, then streams live events", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    const cursor = t.c.store.currentSeq();
    await addProfile(t, "Fast");
    await addProfile(t, "Deep");
    const c = await FakeClient.connect(t, { token: dev.credential });
    const m = await c.hello(cursor);
    expect(m.type).toBe("replay");
    if (m.type !== "replay") return;
    expect(m.events.map((e) => (e.data as { name: string }).name)).toEqual(["Fast", "Deep"]);
    expect(m.events.map((e) => e.seq)).toEqual([cursor + 1, cursor + 2]);
    expect(m.seq).toBe(cursor + 2);

    await addProfile(t, "Live");
    const live = await c.inbox.waitFor((x) => x.type === "event");
    expect(live).toMatchObject({
      type: "event",
      event: { seq: cursor + 3, type: "profile.updated" },
    });
    c.close();
  });

  it("falls back to a snapshot when the cursor predates retention", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    await addProfile(t, "Old");
    const cursor = t.c.store.currentSeq();
    // Age everything past retention and sweep.
    t.clock.advance(31 * 86_400_000);
    await addProfile(t, "New");
    const r = t.c.store.runRetention();
    expect(r.deleted).toBeGreaterThan(0);
    expect(r.minRetainedSeq).toBe(cursor);
    const c = await FakeClient.connect(t, { token: dev.credential });
    const older = await c.hello(cursor - 1);
    expect(older.type).toBe("snapshot");
    const exact = await c.hello(cursor);
    expect(exact.type).toBe("replay");
    if (exact.type === "replay") {
      expect(exact.events.map((e) => (e.data as { name: string }).name)).toEqual(["New"]);
    }
    // A cursor from the future (e.g. after a restore) also gets a snapshot.
    const future = await c.hello(t.c.store.currentSeq() + 100);
    expect(future.type).toBe("snapshot");
    c.close();
  });

  it("stores presence with a 45 s foreground lease", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    const c = await FakeClient.connect(t, { token: dev.credential });
    await c.hello(null);
    const interactedAt = new Date(t.clock.now).toISOString();
    c.send({
      type: "presence",
      presence: { foreground: true, interactedAt, viewing: { sessionId: "ses_v" } },
    });
    await until(() => !!t!.c.store.getPresence(dev.deviceId));
    const p = t.c.store.getPresence(dev.deviceId)!;
    expect(Date.parse(p.foregroundUntil!) - t.clock.now).toBe(45_000);
    expect(p.interactedAt).toBe(interactedAt);
    expect(p.viewingSessionId).toBe("ses_v");
    c.send({ type: "presence", presence: { foreground: false, interactedAt, viewing: null } });
    await until(() => t!.c.store.getPresence(dev.deviceId)!.foregroundUntil === null);
    c.send({ type: "ping" });
    await c.inbox.waitFor((x) => x.type === "pong");
    c.close();
  });
});

describe("unread", () => {
  it("a foreground presence viewing an unread session clears unreadSince", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await FakeHost.connect(t, creds);
    await h.event("session.updated", hostSession("ses_r", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_r", { runtime: "idle" }));
    expect(t.c.store.sessions.get("ses_r")?.unreadSince).toBeTruthy();
    const dev = await enrollDevice(t);
    const c = await FakeClient.connect(t, { token: dev.credential });
    await c.hello(null);
    c.send({
      type: "presence",
      presence: {
        foreground: true,
        interactedAt: new Date(t.clock.now).toISOString(),
        viewing: { sessionId: "ses_r" },
      },
    });
    await until(() => !t!.c.store.sessions.get("ses_r")?.unreadSince);
    c.close();
    await h.close();
  });
});

describe("static web", () => {
  it("serves webDist with SPA fallback and JSON 404s for API paths", async () => {
    const web = tempDir("sy-web-");
    mkdirSync(join(web, "assets"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Switchyard</title>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    t = await startCoordinator({ webDist: web });
    const root = await t.api("GET", "/");
    expect(root.status).toBe(200);
    expect(root.body).toContain("<title>Switchyard</title>");
    const deep = await t.api("GET", "/code/ses_123?interaction=int_1");
    expect(deep.body).toContain("<title>Switchyard</title>");
    const asset = await t.api("GET", "/assets/app.js");
    expect(asset.body).toBe("console.log(1)");
    const api = await t.admin("GET", "/api/nope");
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe("not_found");
  });
});
