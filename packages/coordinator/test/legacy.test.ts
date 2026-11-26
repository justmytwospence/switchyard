// @module-tag slow
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollDevice,
  enrollHost,
  FakeClient,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

/** COMPAT(scopes-rename): what a 0.20 daemon or browser tab still reads and reports. */

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

const ID = "herdr:default@mac";
const enc = encodeURIComponent;
const report = { kind: "herdr", name: "default", machine: "mac" };

async function githubScope(c: TestCoordinator): Promise<string> {
  const host = await enrollHost(c);
  const r = await c.admin("POST", "/api/scopes", {
    name: "work",
    source: { hostId: host.hostId, owner: "acme", enabled: false },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("0.20 clients", () => {
  it("lists views, trackers and terminals in 0.20 shapes", async () => {
    t = await startCoordinator({ scopeSyncTickMs: 0 });
    const work = await githubScope(t);
    const scratch = (await t.admin("POST", "/api/scopes", { name: "scratch", mode: "pinned" })).body
      .id as string;
    await t.admin("PUT", `/api/clients/${enc(ID)}/binding`, { mirror: "scope", scopeId: work });

    const views = (await t.admin("GET", "/api/views")).body;
    expect(views).toMatchObject([
      { id: work, name: "work", trackerId: work, clients: [] },
      { id: scratch, name: "scratch", mode: "pinned", trackerId: null, clients: [] },
    ]);
    expect("source" in views[0]).toBe(false);

    const trackers = (await t.admin("GET", "/api/trackers")).body;
    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      id: work,
      name: "work",
      provider: "github",
      owner: "acme",
      enabled: false,
      login: null,
    });
    expect("kind" in trackers[0]).toBe(false);

    const terminals = (await t.admin("GET", "/api/terminals")).body;
    expect(terminals).toMatchObject([{ id: ID, kind: "herdr", mirror: "view", viewId: work }]);
    expect("scopeId" in terminals[0]).toBe(false);
  });

  it("a 0.20 report and binding with mirror view are recorded as scope", async () => {
    t = await startCoordinator();
    const work = (await t.admin("POST", "/api/scopes", { name: "work" })).body.id as string;
    const other = (await t.admin("POST", "/api/scopes", { name: "other" })).body.id as string;
    const seeded = await t.admin("PUT", `/api/terminals/${enc(ID)}`, {
      ...report,
      shows: ["ses_1"],
      seed: { mirror: "view", viewId: work },
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body).toMatchObject({ mirror: "view", viewId: work, shows: ["ses_1"] });
    expect(t.c.store.clients.require(ID)).toMatchObject({ mirror: "scope", scopeId: work });

    const bound = await t.admin("PUT", `/api/terminals/${enc(ID)}/binding`, {
      mirror: "view",
      viewId: other,
    });
    expect(bound.body).toMatchObject({ mirror: "view", viewId: other });
    expect(t.c.store.clients.require(ID)).toMatchObject({ mirror: "scope", scopeId: other });
    expect(
      (await t.admin("PUT", `/api/terminals/${enc(ID)}/binding`, { mirror: "view" })).status,
    ).toBe(400);
    await t.admin("PUT", `/api/terminals/${enc(ID)}/binding`, { mirror: "all" });
    expect(t.c.store.clients.require(ID)).toMatchObject({ mirror: "all", scopeId: null });

    expect((await t.admin("DELETE", `/api/terminals/${enc(ID)}`)).body).toEqual({
      ok: true,
      id: ID,
    });
    expect(t.c.store.clients.get(ID)).toBeUndefined();
  });

  it("pins through /api/views", async () => {
    t = await startCoordinator();
    const host = await FakeHost.connect(t, await enrollHost(t));
    await host.event("session.updated", hostSession("ses_p", { runtime: "stopped" }));
    await until(() => t!.c.store.sessions.get("ses_p") !== undefined);
    const id = (await t.admin("POST", "/api/scopes", { name: "work", mode: "pinned" })).body
      .id as string;
    const pinned = await t.admin("POST", `/api/views/${id}/sessions/ses_p`);
    expect(pinned.body).toMatchObject({ id, sessionIds: ["ses_p"], trackerId: null });
    expect(t.c.store.scopes.require(id).sessionIds).toEqual(["ses_p"]);
    const unpinned = await t.admin("DELETE", `/api/views/${id}/sessions/ses_p`);
    expect(unpinned.body.sessionIds).toEqual([]);
    await host.close();
  });

  it("creating or editing views and trackers needs a 0.21 client", async () => {
    t = await startCoordinator();
    expect((await t.admin("POST", "/api/views", { name: "work" })).status).toBe(404);
    expect((await t.admin("POST", "/api/trackers", { name: "work" })).status).toBe(404);
    expect((await t.admin("GET", "/api/surfaces")).status).toBe(404);
  });

  it("presence with terminalId is stored for the client", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t);
    const c = await FakeClient.connect(t, { token: dev.credential });
    await c.hello(null);
    c.send({
      type: "presence",
      presence: {
        foreground: true,
        interactedAt: null,
        viewing: { sessionId: "ses_h" },
        terminalId: ID,
      },
    });
    await until(() => t!.c.store.listPresence().some((p) => p.clientId === ID));
    c.send({
      type: "presence",
      presence: { foreground: true, interactedAt: null, viewing: null, clientId: "tmux:a@mac" },
    });
    await until(() => t!.c.store.listPresence().some((p) => p.clientId === "tmux:a@mac"));
    c.close();
  });

  it("without scopes.v1 the socket sends views and terminals; with it, scopes and clients", async () => {
    t = await startCoordinator();
    const work = (await t.admin("POST", "/api/scopes", { name: "work" })).body.id as string;
    const dev = await enrollDevice(t);
    const old = await FakeClient.connect(t, { token: dev.credential });
    const first = await old.hello(null);
    if (first.type !== "snapshot") throw new Error("expected snapshot");
    const state = first.state as unknown as Record<string, any>;
    expect(state.views).toMatchObject([{ id: work, trackerId: null }]);
    expect(state.terminals).toEqual([]);
    expect("scopes" in state).toBe(false);

    const now = await FakeClient.connect(t, { token: dev.credential });
    now.send({ type: "hello", cursor: null, capabilities: ["scopes.v1"] });
    const snap = await now.inbox.waitFor((m) => m.type === "snapshot");
    if (snap.type !== "snapshot") throw new Error("expected snapshot");
    expect(snap.state.scopes).toMatchObject([{ id: work, source: null }]);
    expect(snap.capabilities).toEqual(["scopes.v1"]);

    const fromOld = old.inbox.messages.length;
    const fromNow = now.inbox.messages.length;
    await t.admin("PUT", `/api/clients/${enc(ID)}/binding`, { mirror: "scope", scopeId: work });
    const legacy = await old.inbox.waitFor((m) => m.type === "event", 5000, fromOld);
    const current = await now.inbox.waitFor((m) => m.type === "event", 5000, fromNow);
    expect(legacy).toMatchObject({
      event: { type: "terminal.updated", data: { id: ID, mirror: "view", viewId: work } },
    });
    expect(current).toMatchObject({
      event: { type: "client.updated", data: { id: ID, mirror: "scope", scopeId: work } },
    });
    old.close();
    now.close();
  });
});
