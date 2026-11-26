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
  c.admin("PUT", `/api/clients/${enc(id)}`, b);
const bind = (c: TestCoordinator, b: Record<string, unknown>, id = ID) =>
  c.admin("PUT", `/api/clients/${enc(id)}/binding`, b);
const events = (c: TestCoordinator) =>
  (c.c.store as any).db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'client.updated'")
    .get().n as number;
const scope = async (c: TestCoordinator, name = "work") =>
  (await c.admin("POST", "/api/scopes", { name })).body.id as string;

describe("clients", () => {
  it("a report registers a client that mirrors nothing, and writes again only on change", async () => {
    t = await startCoordinator();
    const r = await put(t, report());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: ID,
      mirror: "none",
      scopeId: null,
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
    expect(t.c.store.clients.require(ID).shows).toEqual(["ses_1"]);
    t.clock.advance(5 * 60_000);
    await put(t, report());
    expect(events(t)).toBe(3);
    expect((await t.admin("GET", "/api/clients")).body).toHaveLength(1);
    expect((await t.admin("DELETE", `/api/clients/${enc(ID)}`)).status).toBe(200);
    expect((await t.admin("GET", "/api/clients")).body).toHaveLength(0);
  });

  it("a seed records the binding once; a report never changes a recorded one", async () => {
    t = await startCoordinator();
    const work = await scope(t);
    const other = await scope(t, "other");
    expect((await put(t, report({ seed: { mirror: "scope", scopeId: work } }))).body).toMatchObject(
      {
        mirror: "scope",
        scopeId: work,
        bindingSetAt: expect.any(String),
      },
    );
    expect(
      (await put(t, report({ seed: { mirror: "scope", scopeId: other } }))).body,
    ).toMatchObject({
      mirror: "scope",
      scopeId: work,
    });
    await bind(t, { mirror: "all" });
    expect((await put(t, report({ seed: { mirror: "none" } }))).body).toMatchObject({
      mirror: "all",
      scopeId: null,
    });
  });

  it("a seed of none is recorded too, so a later seed does not apply", async () => {
    t = await startCoordinator();
    const work = await scope(t);
    await put(t, report({ seed: { mirror: "none" } }));
    const r = await put(t, report({ seed: { mirror: "scope", scopeId: work } }));
    expect(r.body).toMatchObject({ mirror: "none", bindingSetAt: expect.any(String) });
  });

  it("binding is recorded by id, survives renaming, and creates an unseen client", async () => {
    t = await startCoordinator();
    const work = await scope(t);
    const r = await bind(t, { mirror: "scope", scopeId: work }, "tmux:dev@box");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: "tmux:dev@box",
      kind: "tmux",
      name: "dev",
      machine: "box",
      mirror: "scope",
      scopeId: work,
    });
    await t.admin("PATCH", `/api/scopes/${work}`, { name: "renamed" });
    expect(t.c.store.clients.require("tmux:dev@box").scopeId).toBe(work);
    expect((await bind(t, { mirror: "everything" })).status).toBe(400);
    expect((await bind(t, { mirror: "scope" })).status).toBe(400);
    expect((await bind(t, { mirror: "all", scopeId: work })).status).toBe(400);
    expect((await bind(t, { mirror: "scope", scopeId: "viw_nope" })).status).toBe(404);
    expect((await bind(t, { mirror: "all" }, "Screen:x@y")).status).toBe(400);
  });

  it("rejects an id that does not match, and an unknown seeded scope", async () => {
    t = await startCoordinator();
    expect((await put(t, report(), "herdr:other@mac")).status).toBe(400);
    expect((await put(t, report({ seed: { mirror: "scope", scopeId: "viw_nope" } }))).status).toBe(
      404,
    );
  });

  it("keeps a known host id and drops an unknown one", async () => {
    t = await startCoordinator();
    const host = await enrollHost(t);
    expect((await put(t, report({ hostId: host.hostId }))).body.hostId).toBe(host.hostId);
    expect((await put(t, report({ hostId: "hst_nope" }))).body.hostId).toBeNull();
  });

  it("deleting the scope makes its clients mirror nothing, not everything", async () => {
    t = await startCoordinator();
    const work = await scope(t);
    await bind(t, { mirror: "scope", scopeId: work });
    await t.admin("DELETE", `/api/scopes/${work}`);
    expect(t.c.store.clients.require(ID)).toMatchObject({ mirror: "none", scopeId: null });
  });

  it("revoking the device keeps the client and its binding; snapshots include clients", async () => {
    t = await startCoordinator();
    const work = await scope(t);
    const device = await enrollDevice(t);
    const r = await t.api("PUT", `/api/clients/${enc(ID)}`, {
      body: report({ seed: { mirror: "scope", scopeId: work } }),
      token: device.credential,
    });
    expect(r.status).toBe(200);
    expect(t.c.store.syncState().clients).toHaveLength(1);
    await t.admin("POST", `/api/devices/${device.deviceId}/revoke`);
    expect(t.c.store.clients.get(ID)).toMatchObject({ mirror: "scope", scopeId: work });
  });

  it("accepts a kind Switchyard ships no module for", async () => {
    t = await startCoordinator();
    const id = "zellij:main@mac";
    const r = await put(t, { kind: "zellij", name: "main", machine: "mac" }, id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, kind: "zellij", mirror: "none" });
    expect((await bind(t, { mirror: "all" }, id)).body).toMatchObject({ kind: "zellij" });
    expect((await put(t, { kind: "Zellij", name: "main", machine: "mac" }, id)).status).toBe(400);
  });
});
