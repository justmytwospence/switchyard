// @module-tag slow
import type { HostCommand } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("No checkout of this project on second");
  });

  it("pins to the view when the view would not show it", async () => {
    const v = await h.t.admin("POST", "/api/views", { name: "mine", mode: "pinned" });
    const r = await open({ branch: "main", viewId: v.body.id });
    expect(store().views.require(v.body.id).sessionIds).toEqual([r.body.session.id]);
  });
});
