import { afterEach, describe, expect, it } from "vitest";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

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

  it("writes a client report once, then again when it changes", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    const before = viewEvents(t);
    await t.admin("POST", `/api/views/${id}/clients`, client);
    expect(viewEvents(t)).toBe(before + 1);
    t.clock.advance(60_000);
    const again = await t.admin("POST", `/api/views/${id}/clients`, client);
    expect(again.body.clients).toHaveLength(1);
    expect(viewEvents(t)).toBe(before + 1);
    await t.admin("POST", `/api/views/${id}/clients`, { ...client, name: "other" });
    expect(viewEvents(t)).toBe(before + 2);
    const del = await t.admin(
      "DELETE",
      `/api/views/${id}/clients/${encodeURIComponent(client.id)}`,
    );
    expect(del.body.clients).toHaveLength(0);
  });

  it("pins and unpins, and an unknown session is not found", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    expect((await t.admin("POST", `/api/views/${id}/sessions/ses_nope`)).status).toBe(404);
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
