// @module-tag slow
import type { HostCommand } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBranch } from "../src/branches.js";
import { enrollHost, FakeHost, until } from "./helpers.js";
import {
  commandsOf,
  type Harness,
  HostState,
  ROOT,
  setupHarness,
  smartHandler,
} from "./task-helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
  h.override = (cmd: HostCommand) => {
    if (cmd.type === "workspace.create") {
      return { path: `${ROOT}/.worktrees/${cmd.branch.replaceAll("/", "-")}`, branch: cmd.branch };
    }
    if (cmd.type === "session.start") {
      return {
        nativeHandle: { sessionId: `n-${cmd.sessionId}`, sessionFile: `/s/${cmd.sessionId}` },
      };
    }
    return undefined;
  };
});

afterEach(async () => {
  await h.t.cleanup();
});

const store = () => h.t.c.store;
const open = (body: Record<string, unknown>) =>
  h.t.admin("POST", "/api/branches/open", { projectId: h.project.id, ...body });
const mainWs = () =>
  store()
    .workspaces.list()
    .find((w) => w.provenance === "main")!;

describe("open branch", () => {
  it("does not provision when strict remote preparation fails", async () => {
    const request = vi.spyOn(h.t.c.hostHub, "request").mockRejectedValue(new Error("fetch failed"));
    await expect(
      openBranch(h.t.c.ctx, {
        projectId: h.project.id,
        branch: "remote-issue",
        requireRemoteBranch: true,
      }),
    ).rejects.toThrow("fetch failed");
    expect(store().sessions.list()).toHaveLength(0);
    request.mockRestore();
  });

  it("requires a positive preparation result for a linked remote branch", async () => {
    const request = vi.spyOn(h.t.c.hostHub, "request").mockResolvedValue({ ok: false });
    try {
      await expect(
        openBranch(h.t.c.ctx, {
          projectId: h.project.id,
          branch: "remote-issue",
          requireRemoteBranch: true,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(store().sessions.list()).toHaveLength(0);
    } finally {
      request.mockRestore();
    }
  });

  it("starts a session in an existing worktree that has none, then opens it", async () => {
    const first = await open({ branch: "main" });
    expect(first.status).toBe(202);
    expect(first.body.session.workspaceId).toBe(mainWs().id);
    const again = await open({ branch: "main" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, session: { id: first.body.session.id } });
  });

  it("starts another session when asked", async () => {
    const first = await open({ branch: "main" });
    const second = await open({ branch: "main", another: true });
    expect(second.status).toBe(202);
    expect(second.body.session.id).not.toBe(first.body.session.id);
  });

  it("creates the worktree for a new branch", async () => {
    const r = await open({ branch: "feat/z", title: "Z" });
    expect(r.status).toBe(202);
    expect(r.body.session.title).toBe("Z");
    await until(() => commandsOf(h.host, "workspace.create").length === 1);
    expect(commandsOf(h.host, "workspace.create")[0]).toMatchObject({ branch: "feat/z" });
    expect(commandsOf(h.host, "tracker.prepareBranch")[0]).toMatchObject({ branch: "feat/z" });
  });

  it("records a worktree already created but does not start Pi after delisting", async () => {
    const previous = h.override!;
    h.override = (cmd, id) => {
      if (cmd.type === "workspace.create") {
        const p = store().projects.require(h.project.id);
        store().putProject({ ...p, catalog: { ...p.catalog, state: "delisted" } });
      }
      return previous(cmd, id);
    };
    const r = await open({ branch: "feat/removed" });
    expect(r.status).toBe(202);
    await until(() => store().sessions.get(r.body.session.id)?.runtime === "failed");
    expect(
      store().workspaceByPath(h.creds.hostId, `${ROOT}/.worktrees/feat-removed`),
    ).toBeDefined();
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(1);
    expect(commandsOf(h.host, "session.start")).toHaveLength(0);
    expect(commandsOf(h.host, "workspace.remove")).toHaveLength(0);
  });

  it("picks the host that has the branch, then the project default", async () => {
    const creds2 = await enrollHost(h.t, "second");
    const host2 = await FakeHost.connect(
      h.t,
      creds2,
      smartHandler(new HostState(), () => h.override),
    );
    store().putCheckout({
      id: "chk_second",
      projectId: h.project.id,
      hostId: creds2.hostId,
      path: "/other/app",
      commonDir: "/other/app/.git",
      defaultBranch: "main",
      createdAt: store().nowIso(),
    });
    store().putProject({ ...store().projects.require(h.project.id), defaultHostId: creds2.hostId });
    const onMain = await open({ branch: "main" });
    expect(onMain.body.session.hostId).toBe(h.creds.hostId);
    const fresh = await open({ branch: "feat/new" });
    expect(fresh.body.session.hostId).toBe(creds2.hostId);
    await host2.close();
  });

  it("rejects a host without a checkout of the project", async () => {
    const creds2 = await enrollHost(h.t, "second");
    const r = await open({ branch: "main", hostId: creds2.hostId });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("Prepare a checkout on this host");
  });

  it("keeps history readable and live sessions stoppable while blocking fresh work", async () => {
    const started = await open({ branch: "main" });
    const id = started.body.session.id;
    await until(() => !!store().sessions.get(id)?.nativeHandle);
    const project = store().projects.require(h.project.id);
    store().putProject({ ...project, catalog: { ...project.catalog, state: "delisted" } });
    store().putSession({ ...store().sessions.require(id), runtime: "idle" });

    expect((await h.t.admin("GET", `/api/sessions/${id}`)).status).toBe(200);
    expect((await h.t.admin("GET", `/api/workspaces/${mainWs().id}`)).status).toBe(200);
    expect((await h.t.admin("POST", `/api/sessions/${id}/stop`)).status).toBe(200);
    expect(commandsOf(h.host, "session.abort")).toHaveLength(1);
    store().putSession({ ...store().sessions.require(id), runtime: "stopped" });
    expect((await h.t.admin("POST", `/api/sessions/${id}/resume`)).status).toBe(409);
    expect((await open({ branch: "feat/new" })).status).toBe(409);
    expect(
      (
        await h.t.admin("POST", "/api/sessions", {
          projectId: project.id,
          workspace: { existingId: mainWs().id },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await h.t.admin("POST", "/api/workspaces", {
          checkoutId: mainWs().checkoutId,
          branch: "feat/new",
        })
      ).status,
    ).toBe(409);
    expect(store().sessions.list()).toHaveLength(1);
    expect(commandsOf(h.host, "session.start")).toHaveLength(1);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    expect(commandsOf(h.host, "tracker.prepareBranch")).toHaveLength(0);
  });

  it("pins to the scope when the scope would not show it", async () => {
    const v = await h.t.admin("POST", "/api/scopes", { name: "mine", mode: "pinned" });
    const r = await open({ branch: "main", scopeId: v.body.id });
    expect(store().scopes.require(v.body.id).sessionIds).toEqual([r.body.session.id]);
  });

  it("does not pin a new session to a GitHub scope of its project", async () => {
    const v = await h.t.admin("POST", "/api/scopes", {
      name: "tracked",
      projectIds: [h.project.id],
    });
    store().putScope({
      ...store().scopes.require(v.body.id),
      source: {
        kind: "github",
        hostId: h.creds.hostId,
        owner: "acme",
        repositories: null,
        board: null,
        writeBack: false,
        moveShared: true,
        enabled: false,
        login: null,
        lastSyncedAt: null,
        lastError: null,
      },
    });
    await open({ branch: "main", scopeId: v.body.id });
    expect(store().scopes.require(v.body.id).sessionIds).toEqual([]);
  });
});
