// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import { enrollDevice, enrollHost, startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ID = "herdr:default@mac";
const body = (over: Record<string, unknown> = {}) => ({
  kind: "herdr",
  name: "default",
  machine: "mac",
  viewId: null,
  ...over,
});
const put = (c: TestCoordinator, b: Record<string, unknown>, id = ID) =>
  c.admin("PUT", `/api/surfaces/${encodeURIComponent(id)}`, b);
const events = (c: TestCoordinator) =>
  (c.c.store as any).db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'surface.updated'")
    .get().n as number;

describe("surfaces", () => {
  it("reports once, then again when it changes", async () => {
    t = await startCoordinator();
    const v = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    const r = await put(t, body({ viewId: v }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, viewId: v, hostId: null, deviceId: "dev_localadmin" });
    await put(t, body({ viewId: v }));
    expect(events(t)).toBe(1);
    await put(t, body({ viewId: null }));
    expect(events(t)).toBe(2);
    expect((await t.admin("GET", "/api/surfaces")).body).toHaveLength(1);
    expect((await t.admin("DELETE", `/api/surfaces/${encodeURIComponent(ID)}`)).status).toBe(200);
    expect((await t.admin("GET", "/api/surfaces")).body).toHaveLength(0);
  });

  it("rejects an id that does not match, and an unknown view", async () => {
    t = await startCoordinator();
    expect((await put(t, body(), "herdr:other@mac")).status).toBe(400);
    expect((await put(t, body({ viewId: "viw_nope" }))).status).toBe(404);
  });

  it("keeps a known host id and drops an unknown one", async () => {
    t = await startCoordinator();
    const host = await enrollHost(t);
    expect((await put(t, body({ hostId: host.hostId }))).body.hostId).toBe(host.hostId);
    expect((await put(t, body({ hostId: "hst_nope" }))).body.hostId).toBeNull();
  });

  it("deleting the view unbinds its surfaces", async () => {
    t = await startCoordinator();
    const v = (await t.admin("POST", "/api/views", { name: "work" })).body.id;
    await put(t, body({ viewId: v }));
    await t.admin("DELETE", `/api/views/${v}`);
    expect(t.c.store.surfaces.require(ID).viewId).toBeNull();
  });

  it("revoking the device removes its surfaces, and snapshots include surfaces", async () => {
    t = await startCoordinator();
    const device = await enrollDevice(t);
    const r = await t.api("PUT", `/api/surfaces/${encodeURIComponent(ID)}`, {
      body: body(),
      token: device.credential,
    });
    expect(r.status).toBe(200);
    expect((t.c.store.syncState() as any).surfaces).toHaveLength(1);
    await t.admin("POST", `/api/devices/${device.deviceId}/revoke`);
    expect(t.c.store.surfaces.get(ID)).toBeUndefined();
  });
});
