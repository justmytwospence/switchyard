// @module-tag slow
import type { HostCommand } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostSession, until } from "./helpers.js";
import { commandsOf, type Harness, ROOT, setupHarness } from "./task-helpers.js";

const WT = `${ROOT}/.worktrees/feat-x`;

function worktree(path: string, branch: string, provenance: "main" | "discovered") {
  return {
    path,
    head: "a".repeat(40),
    branch: `refs/heads/${branch}`,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    provenance,
    git: null,
  };
}

let h: Harness;
let trees: ReturnType<typeof worktree>[];
beforeEach(async () => {
  h = await setupHarness();
  trees = [worktree(ROOT, "main", "main")];
  h.override = (cmd: HostCommand) => (cmd.type === "workspace.discover" ? trees : undefined);
  // Discover the main checkout as a workspace.
  expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
});
afterEach(async () => {
  await h.t.cleanup();
});

describe("sessions a host announces from your terminal", () => {
  it("map to the workspace containing their cwd and are pinned to their client's view", async () => {
    const client = "herdr:daily@mac";
    const view = await h.t.admin("POST", "/api/views", {
      name: "daily",
      mode: "pinned",
      clientId: client,
    });
    expect(view.status).toBe(201);
    const other = await h.t.admin("POST", "/api/views", { name: "other", mode: "pinned" });
    await h.host.event(
      "session.updated",
      hostSession("ses_ext", {
        cwd: `${ROOT}/packages/app`,
        workspaceId: null,
        projectId: null,
        external: { client },
        terminal: false,
      }),
    );
    await until(() => h.t.c.store.sessions.get("ses_ext") !== undefined);
    const s = h.t.c.store.sessions.require("ses_ext");
    const ws = h.t.c.store.workspaceByPath(h.creds.hostId, ROOT)!;
    expect(s).toMatchObject({ workspaceId: ws.id, projectId: h.project.id, external: { client } });
    await until(() => h.t.c.store.views.require(view.body.id).sessionIds.includes("ses_ext"));
    expect(h.t.c.store.views.require(other.body.id).sessionIds).toEqual([]);
  });

  it("leave a cwd outside every workspace without a project", async () => {
    await h.host.event(
      "session.updated",
      hostSession("ses_loose", { cwd: "/elsewhere", workspaceId: null, projectId: null }),
    );
    await until(() => h.t.c.store.sessions.get("ses_loose") !== undefined);
    expect(h.t.c.store.sessions.require("ses_loose")).toMatchObject({
      workspaceId: null,
      projectId: null,
    });
  });

  const store = () => h.t.c.store;
  let before = 0;
  beforeEach(() => {
    before = commandsOf(h.host, "workspace.discover").length;
  });
  /** Discovery commands since the test started (setup runs some of its own). */
  const discovers = () => commandsOf(h.host, "workspace.discover").length - before;
  const wsAt = (path: string) => store().workspaceByPath(h.creds.hostId, path)!;
  const announce = (id: string, over: Record<string, unknown>) =>
    h.host.event(
      "session.updated",
      hostSession(id, {
        workspaceId: null,
        projectId: null,
        provenance: "imported",
        external: { client: "herdr:d@mac" },
        terminal: false,
        ...over,
      }),
    );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("move to a worktree found by a rescan", async () => {
    trees = [worktree(ROOT, "main", "main"), worktree(WT, "feat/x", "discovered")];
    await announce("ses_wt", { cwd: WT });
    await until(() => store().sessions.get("ses_wt")?.workspaceId === wsAt(WT)?.id);
    expect(store().sessions.require("ses_wt").projectId).toBe(h.project.id);
    expect(discovers()).toBe(1);
  });

  it("rescan once for a session in a subfolder of the main checkout", async () => {
    await announce("ses_sub", { cwd: `${ROOT}/packages/app` });
    await until(() => discovers() === 1);
    await announce("ses_sub", {
      cwd: `${ROOT}/packages/app`,
      lastActivityAt: new Date(Date.now() + 1000).toISOString(),
    });
    await sleep(50);
    expect(discovers()).toBe(1);
    expect(store().sessions.require("ses_sub").workspaceId).toBe(wsAt(ROOT).id);
  });

  it("leave sessions Switchyard created where they are", async () => {
    await announce("ses_a", { cwd: `${ROOT}/x` });
    await until(() => store().sessions.get("ses_a") !== undefined);
    await until(() => discovers() === 1);
    const main = wsAt(ROOT).id;
    const base = store().sessions.require("ses_a");
    const copy = (id: string) => ({
      ...base,
      id,
      cwd: WT,
      nativeHandle: { sessionId: `n-${id}`, sessionFile: `/tmp/${id}.jsonl` },
    });
    store().putSession({ ...copy("ses_created"), provenance: "created" });
    store().putSession({ ...copy("ses_task"), taskId: "tsk_x" });
    trees = [worktree(ROOT, "main", "main"), worktree(WT, "feat/x", "discovered")];
    expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
    expect(store().sessions.require("ses_created").workspaceId).toBe(main);
    expect(store().sessions.require("ses_task").workspaceId).toBe(main);
  });

  it("Refresh moves a session already filed under the main checkout", async () => {
    await announce("ses_old", { cwd: WT });
    await until(() => discovers() === 1);
    await sleep(20);
    expect(store().sessions.require("ses_old").workspaceId).toBe(wsAt(ROOT).id);
    trees = [worktree(ROOT, "main", "main"), worktree(WT, "feat/x", "discovered")];
    expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
    expect(store().sessions.require("ses_old").workspaceId).toBe(wsAt(WT).id);
  });
});
