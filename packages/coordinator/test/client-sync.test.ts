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
