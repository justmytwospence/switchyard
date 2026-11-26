// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import { enrollDevice, enrollHost, startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ID = "herdr:default@mac";
const enc = encodeURIComponent;
const report = (over: Record<string, unknown> = {}) => ({
  kind: "herdr",
  name: "default",
  machine: "mac",
  ...over,
});
const put = (c: TestCoordinator, b: Record<string, unknown>, id = ID) =>
  c.admin("PUT", `/api/terminals/${enc(id)}`, b);
const bind = (c: TestCoordinator, b: Record<string, unknown>, id = ID) =>
  c.admin("PUT", `/api/terminals/${enc(id)}/binding`, b);
const events = (c: TestCoordinator) =>
  (c.c.store as any).db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'terminal.updated'")
    .get().n as number;
const view = async (c: TestCoordinator, name = "work") =>
  (await c.admin("POST", "/api/views", { name })).body.id as string;

describe("terminals", () => {
  it("a report registers a terminal that mirrors nothing, and writes again only on change", async () => {
    t = await startCoordinator();
    const r = await put(t, report());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: ID,
      mirror: "none",
      viewId: null,
      bindingSetAt: null,
      shows: [],
      hostId: null,
      deviceId: "dev_localadmin",
    });
    await put(t, report());
    expect(events(t)).toBe(1);
    await put(t, report({ shows: ["ses_1"] }));
    expect(events(t)).toBe(2);
    await put(t, report());
    expect(events(t)).toBe(2);
    expect(t.c.store.terminals.require(ID).shows).toEqual(["ses_1"]);
    t.clock.advance(5 * 60_000);
    await put(t, report());
    expect(events(t)).toBe(3);
    expect((await t.admin("GET", "/api/terminals")).body).toHaveLength(1);
    expect((await t.admin("DELETE", `/api/terminals/${enc(ID)}`)).status).toBe(200);
    expect((await t.admin("GET", "/api/terminals")).body).toHaveLength(0);
  });

  it("a seed records the binding once; a report never changes a recorded one", async () => {
    t = await startCoordinator();
    const work = await view(t);
    const other = await view(t, "other");
    expect((await put(t, report({ seed: { mirror: "view", viewId: work } }))).body).toMatchObject({
      mirror: "view",
      viewId: work,
      bindingSetAt: expect.any(String),
    });
    expect((await put(t, report({ seed: { mirror: "view", viewId: other } }))).body).toMatchObject({
      mirror: "view",
      viewId: work,
    });
    await bind(t, { mirror: "all" });
    expect((await put(t, report({ seed: { mirror: "none" } }))).body).toMatchObject({
      mirror: "all",
      viewId: null,
    });
  });

  it("a seed of none is recorded too, so a later seed does not apply", async () => {
    t = await startCoordinator();
    const work = await view(t);
    await put(t, report({ seed: { mirror: "none" } }));
    const r = await put(t, report({ seed: { mirror: "view", viewId: work } }));
    expect(r.body).toMatchObject({ mirror: "none", bindingSetAt: expect.any(String) });
  });

  it("binding is recorded by id, survives renaming, and creates an unseen terminal", async () => {
    t = await startCoordinator();
    const work = await view(t);
    const r = await bind(t, { mirror: "view", viewId: work }, "tmux:dev@box");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: "tmux:dev@box",
      kind: "tmux",
      name: "dev",
      machine: "box",
      mirror: "view",
      viewId: work,
    });
    await t.admin("PATCH", `/api/views/${work}`, { name: "renamed" });
    expect(t.c.store.terminals.require("tmux:dev@box").viewId).toBe(work);
    expect((await bind(t, { mirror: "everything" })).status).toBe(400);
    expect((await bind(t, { mirror: "view" })).status).toBe(400);
    expect((await bind(t, { mirror: "all", viewId: work })).status).toBe(400);
    expect((await bind(t, { mirror: "view", viewId: "viw_nope" })).status).toBe(404);
    expect((await bind(t, { mirror: "all" }, "screen:x@y")).status).toBe(400);
  });

  it("rejects an id that does not match, and an unknown seeded view", async () => {
    t = await startCoordinator();
    expect((await put(t, report(), "herdr:other@mac")).status).toBe(400);
    expect((await put(t, report({ seed: { mirror: "view", viewId: "viw_nope" } }))).status).toBe(
      404,
    );
  });

  it("keeps a known host id and drops an unknown one", async () => {
    t = await startCoordinator();
    const host = await enrollHost(t);
    expect((await put(t, report({ hostId: host.hostId }))).body.hostId).toBe(host.hostId);
    expect((await put(t, report({ hostId: "hst_nope" }))).body.hostId).toBeNull();
  });

  it("deleting the view makes its terminals mirror nothing, not everything", async () => {
    t = await startCoordinator();
    const work = await view(t);
    await bind(t, { mirror: "view", viewId: work });
    await t.admin("DELETE", `/api/views/${work}`);
    expect(t.c.store.terminals.require(ID)).toMatchObject({ mirror: "none", viewId: null });
  });

  it("revoking the device keeps the terminal and its binding; snapshots include terminals", async () => {
    t = await startCoordinator();
    const work = await view(t);
    const device = await enrollDevice(t);
    const r = await t.api("PUT", `/api/terminals/${enc(ID)}`, {
      body: report({ seed: { mirror: "view", viewId: work } }),
      token: device.credential,
    });
    expect(r.status).toBe(200);
    expect((t.c.store.syncState() as any).terminals).toHaveLength(1);
    await t.admin("POST", `/api/devices/${device.deviceId}/revoke`);
    expect(t.c.store.terminals.get(ID)).toMatchObject({ mirror: "view", viewId: work });
  });

  describe("legacy surface routes (CLI 0.19)", () => {
    const surface = (over: Record<string, unknown> = {}) => ({
      ...report(),
      viewId: null,
      ...over,
    });

    it("a report with a view seeds the binding; withdrawing keeps it", async () => {
      t = await startCoordinator();
      const work = await view(t);
      const r = await t.admin("PUT", `/api/surfaces/${enc(ID)}`, surface({ viewId: work }));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: ID, viewId: work });
      expect((await t.admin("DELETE", `/api/surfaces/${enc(ID)}`)).status).toBe(200);
      expect(t.c.store.terminals.require(ID)).toMatchObject({ mirror: "view", viewId: work });
    });

    it("lists a terminal's view only when it mirrors one", async () => {
      t = await startCoordinator();
      await bind(t, { mirror: "all" });
      const list = (await t.admin("GET", "/api/surfaces")).body;
      expect(list).toMatchObject([{ id: ID, viewId: null }]);
      expect(
        (await t.admin("PUT", `/api/surfaces/${enc(ID)}`, surface({ viewId: "viw_nope" }))).status,
      ).toBe(200);
    });
  });
});
