// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
} from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const client = { id: "herdr:default@mac", kind: "herdr", name: "default", machine: "mac" };
const viewEvents = (c: TestCoordinator) =>
  (c.c.store as any).db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'view.updated'")
    .get().n as number;

describe("views", () => {
  it("creates, lists, patches and deletes", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/views", { name: "work" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "work", mode: "all", projectIds: null, sessionIds: [] });
    const id = r.body.id as string;
    expect((await t.admin("GET", "/api/views")).body).toHaveLength(1);
    const p = await t.admin("PATCH", `/api/views/${id}`, { mode: "pinned", name: "Work2" });
    expect(p.body).toMatchObject({ mode: "pinned", name: "Work2" });
    expect((await t.admin("DELETE", `/api/views/${id}`)).body).toEqual({ ok: true, id });
    expect((await t.admin("GET", "/api/views")).body).toHaveLength(0);
  });

  it("rejects a duplicate name, ignoring case", async () => {
    t = await startCoordinator();
    await t.admin("POST", "/api/views", { name: "work" });
    const r = await t.admin("POST", "/api/views", { name: "WORK" });
    expect(r.status).toBe(409);
  });

  it("a legacy client report seeds a terminal once, then refreshes it when stale", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    const surfaceEvents = () =>
      (t!.c.store as any).db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'terminal.updated'")
        .get().n as number;
    const before = viewEvents(t);
    const r = await t.admin("POST", `/api/views/${id}/clients`, client);
    expect(r.body.clients).toEqual([]);
    expect(viewEvents(t)).toBe(before);
    expect(surfaceEvents()).toBe(1);
    t.clock.advance(60_000);
    await t.admin("POST", `/api/views/${id}/clients`, client);
    expect(surfaceEvents()).toBe(1);
    t.clock.advance(5 * 60_000);
    await t.admin("POST", `/api/views/${id}/clients`, client);
    expect(surfaceEvents()).toBe(2);
    expect(t.c.store.terminals.require(client.id)).toMatchObject({
      mirror: "view",
      viewId: id,
      kind: "herdr",
    });
    await t.admin("DELETE", `/api/views/${id}/clients/${encodeURIComponent(client.id)}`);
    expect(t.c.store.terminals.get(client.id)).toMatchObject({ viewId: id });
  });

  it("pins and unpins, and an unknown session is not found", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    expect((await t.admin("POST", `/api/views/${id}/sessions/ses_nope`)).status).toBe(404);
  });

  it("an archived session leaves every view and cannot be pinned again", async () => {
    t = await startCoordinator();
    const host = await FakeHost.connect(t, await enrollHost(t));
    await host.event("session.updated", hostSession("ses_p", { runtime: "stopped" }));
    const a = (await t.admin("POST", "/api/views", { name: "a" })).body.id as string;
    const b = (await t.admin("POST", "/api/views", { name: "b" })).body.id as string;
    for (const v of [a, b]) {
      expect((await t.admin("POST", `/api/views/${v}/sessions/ses_p`)).status).toBe(200);
    }
    expect((await t.admin("POST", "/api/sessions/ses_p/archive")).status).toBe(200);
    expect(t.c.store.views.require(a).sessionIds).toEqual([]);
    expect(t.c.store.views.require(b).sessionIds).toEqual([]);
    const again = await t.admin("POST", `/api/views/${a}/sessions/ses_p`);
    expect(again.status).toBe(409);
    await host.close();
  });

  it("an unknown viewId creates no session, and snapshots include views", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/sessions", {
      projectId: "prj_x",
      workspace: { existingId: "wsp_x" },
      viewId: "viw_nope",
    });
    expect(r.status).toBe(404);
    expect((await t.admin("GET", "/api/sessions")).body).toHaveLength(0);
    expect((t.c.store.syncState() as any).views).toEqual([]);
  });
});
