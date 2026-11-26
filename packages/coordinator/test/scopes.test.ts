// @module-tag slow
import type { HostCommand } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
} from "./helpers.js";
import { type Harness, setupHarness } from "./task-helpers.js";

let t: TestCoordinator | undefined;
let h: Harness | undefined;
afterEach(async () => {
  await t?.cleanup();
  await h?.t.cleanup();
  t = undefined;
  h = undefined;
});

describe("scopes", () => {
  it("creates, lists, patches and deletes", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/scopes", { name: "work" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: "work",
      mode: "all",
      projectIds: null,
      sessionIds: [],
      source: null,
    });
    const id = r.body.id as string;
    expect(id).toMatch(/^scp_/);
    expect((await t.admin("GET", "/api/scopes")).body).toHaveLength(1);
    const p = await t.admin("PATCH", `/api/scopes/${id}`, { mode: "pinned", name: "Work2" });
    expect(p.body).toMatchObject({ mode: "pinned", name: "Work2" });
    expect((await t.admin("DELETE", `/api/scopes/${id}`)).body).toEqual({ ok: true, id });
    expect((await t.admin("GET", "/api/scopes")).body).toHaveLength(0);
  });

  it("rejects a duplicate name, ignoring case", async () => {
    t = await startCoordinator();
    await t.admin("POST", "/api/scopes", { name: "work" });
    const r = await t.admin("POST", "/api/scopes", { name: "WORK" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("A scope named WORK exists");
  });

  it("pins and unpins, and an unknown session is not found", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/scopes", { name: "work" })).body.id;
    expect((await t.admin("POST", `/api/scopes/${id}/sessions/ses_nope`)).status).toBe(404);
  });

  it("an archived session leaves every scope and cannot be pinned again", async () => {
    t = await startCoordinator();
    const host = await FakeHost.connect(t, await enrollHost(t));
    await host.event("session.updated", hostSession("ses_p", { runtime: "stopped" }));
    const a = (await t.admin("POST", "/api/scopes", { name: "a" })).body.id as string;
    const b = (await t.admin("POST", "/api/scopes", { name: "b" })).body.id as string;
    for (const v of [a, b]) {
      expect((await t.admin("POST", `/api/scopes/${v}/sessions/ses_p`)).status).toBe(200);
    }
    expect((await t.admin("POST", "/api/sessions/ses_p/archive")).status).toBe(200);
    expect(t.c.store.scopes.require(a).sessionIds).toEqual([]);
    expect(t.c.store.scopes.require(b).sessionIds).toEqual([]);
    const again = await t.admin("POST", `/api/scopes/${a}/sessions/ses_p`);
    expect(again.status).toBe(409);
    await host.close();
  });

  it("an unknown scopeId creates no session, and snapshots include scopes", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/sessions", {
      projectId: "prj_x",
      workspace: { existingId: "wsp_x" },
      scopeId: "scp_nope",
    });
    expect(r.status).toBe(404);
    expect((await t.admin("GET", "/api/sessions")).body).toHaveLength(0);
    expect(t.c.store.syncState().scopes).toEqual([]);
  });

  it("viewId is still accepted when starting a session", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/sessions", {
      projectId: "prj_x",
      workspace: { existingId: "wsp_x" },
      viewId: "viw_nope",
    });
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("Scope viw_nope not found");
  });

  it("a sync of a scope without a source is refused", async () => {
    t = await startCoordinator();
    const id = (await t.admin("POST", "/api/scopes", { name: "work" })).body.id;
    const r = await t.admin("POST", `/api/scopes/${id}/sync`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("This scope has no source to sync");
  });
});

describe("GitHub scopes", () => {
  const REPO = "acme/app";
  const item = {
    itemId: "I_1",
    repository: REPO,
    number: 1,
    title: "Issue 1",
    url: `https://github.com/${REPO}/issues/1`,
    assignees: ["me"],
    branches: [],
    pullRequest: null,
    board: null,
  };
  async function github(): Promise<Harness> {
    const x = await setupHarness();
    const p = x.t.c.store.projects.require(x.project.id);
    x.t.c.store.putProject({ ...p, repoIdentity: `https://github.com/${REPO}` });
    x.override = (cmd: HostCommand) =>
      cmd.type === "tracker.sync" ? { login: "me", items: [item], truncated: false } : undefined;
    return x;
  }
  const source = (x: Harness, over: Record<string, unknown> = {}) => ({
    hostId: x.creds.hostId,
    owner: "acme",
    worktrees: false,
    ...over,
  });
  const sync = (x: Harness, id: string) => x.t.admin("POST", `/api/scopes/${id}/sync`);

  it("creates a GitHub scope with its projects set", async () => {
    h = await github();
    const r = await h.t.admin("POST", "/api/scopes", {
      name: "work",
      projectIds: ["prj_ignored"],
      source: source(h),
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: "work",
      mode: "all",
      projectIds: [h.project.id],
      source: {
        kind: "github",
        owner: "acme",
        follow: "assigned",
        writeBack: false,
        enabled: true,
        login: null,
        lastSyncedAt: null,
      },
    });
    const synced = (await sync(h, r.body.id)).body;
    expect(synced.source).toMatchObject({ login: "me", lastError: null });
    expect(h.t.c.store.issues.list()).toMatchObject([
      { id: `${r.body.id}:I_1`, scopeId: r.body.id, trackerId: r.body.id },
    ]);
  });

  it("PATCH source null removes its issues and keeps its projects", async () => {
    h = await github();
    const id = (await h.t.admin("POST", "/api/scopes", { name: "work", source: source(h) })).body
      .id as string;
    await sync(h, id);
    expect(h.t.c.store.issues.list()).toHaveLength(1);
    const r = await h.t.admin("PATCH", `/api/scopes/${id}`, { source: null });
    expect(r.body).toMatchObject({ source: null, projectIds: [h.project.id] });
    expect(h.t.c.store.issues.list()).toHaveLength(0);
    // Its projects are its own again.
    const own = await h.t.admin("PATCH", `/api/scopes/${id}`, { projectIds: null });
    expect(own.body.projectIds).toBeNull();
  });

  it("adds a source to a scope of chosen projects", async () => {
    h = await github();
    const id = (await h.t.admin("POST", "/api/scopes", { name: "work", projectIds: [] })).body
      .id as string;
    const partial = await h.t.admin("PATCH", `/api/scopes/${id}`, { source: { owner: "acme" } });
    expect(partial.status).toBe(400);
    expect(partial.body.error.message).toBe("A GitHub source needs a host and an owner");
    const r = await h.t.admin("PATCH", `/api/scopes/${id}`, { source: source(h) });
    expect(r.body).toMatchObject({ projectIds: [h.project.id], source: { owner: "acme" } });
    const edited = await h.t.admin("PATCH", `/api/scopes/${id}`, { source: { enabled: false } });
    expect(edited.body.source).toMatchObject({ owner: "acme", enabled: false });
  });

  it("rejects projectIds on a GitHub scope", async () => {
    h = await github();
    const id = (await h.t.admin("POST", "/api/scopes", { name: "work", source: source(h) })).body
      .id as string;
    const r = await h.t.admin("PATCH", `/api/scopes/${id}`, { projectIds: null });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("This scope's projects are kept by GitHub");
    const both = await h.t.admin("PATCH", `/api/scopes/${id}`, { source: null, projectIds: null });
    expect(both.body).toMatchObject({ source: null, projectIds: null });
    const adding = await h.t.admin("PATCH", `/api/scopes/${id}`, {
      source: source(h),
      projectIds: null,
    });
    expect(adding.status).toBe(409);
  });

  it("follows a board only with a board", async () => {
    h = await github();
    const r = await h.t.admin("POST", "/api/scopes", {
      name: "work",
      source: source(h, { follow: "board" }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("Following a board needs a board number");
  });

  it("deleting a scope removes its issues and unbinds its clients", async () => {
    h = await github();
    const id = (await h.t.admin("POST", "/api/scopes", { name: "work", source: source(h) })).body
      .id as string;
    await sync(h, id);
    const client = "herdr:default@mac";
    await h.t.admin("PUT", `/api/clients/${encodeURIComponent(client)}/binding`, {
      mirror: "scope",
      scopeId: id,
    });
    expect((await h.t.admin("DELETE", `/api/scopes/${id}`)).body).toEqual({ ok: true, id });
    expect(h.t.c.store.issues.list()).toHaveLength(0);
    expect(h.t.c.store.clients.require(client)).toMatchObject({ mirror: "none", scopeId: null });
  });
});
