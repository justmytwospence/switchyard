// @module-tag slow
import type { GitState, HostCommand } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/index.js";
import { LANDED_GRACE_MS } from "../src/workspace-lifecycle.js";
import { until } from "./helpers.js";
import { commandsOf, type Harness, ROOT, setupHarness } from "./task-helpers.js";

const WT = `${ROOT}/.worktrees/feat-x`;
const HEAD = "a".repeat(40);

function worktree(path: string, branch: string, provenance: "main" | "discovered" | "managed") {
  return {
    path,
    head: HEAD,
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
let status: GitState;
let pr: { state: "OPEN" | "MERGED"; headRefOid: string } | null;

beforeEach(async () => {
  h = await setupHarness();
  trees = [worktree(ROOT, "main", "main"), worktree(WT, "feat/x", "discovered")];
  status = { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: true, head: HEAD };
  pr = null;
  h.override = (cmd: HostCommand) => {
    if (cmd.type === "workspace.discover") return trees;
    if (cmd.type === "workspace.status") return { path: cmd.path, git: status };
    if (cmd.type === "workspace.remove") {
      trees = trees.filter((t) => t.path !== cmd.path);
      return { ok: true, path: cmd.path };
    }
    return undefined;
  };
  vi.spyOn(requireService(h.t.c.ctx, "github"), "refresh").mockImplementation(async () => ({
    github: { available: true, reason: null },
    snapshot: pr
      ? ({ status: "ready", pullRequest: { number: 7, ...pr } } as never)
      : ({ status: "ready", pullRequest: null } as never),
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.t.cleanup();
});

const lifecycle = () => requireService(h.t.c.ctx, "workspaceLifecycle");
const store = () => h.t.c.store;
const patch = (body: Record<string, unknown>) =>
  h.t.admin("PATCH", `/api/projects/${h.project.id}`, body);
const openSessions = () =>
  store()
    .sessions.list("archived_at IS NULL", [])
    .filter((s) => s.cwd === WT);

describe("ensure sessions", () => {
  beforeEach(async () => {
    expect((await patch({ ensureSessions: true })).status).toBe(200);
  });

  it("starts one session per non-main worktree, once", async () => {
    await lifecycle().tick();
    await until(() => commandsOf(h.host, "session.start").length === 1);
    expect(commandsOf(h.host, "session.start")[0]!.workspacePath).toBe(WT);
    expect(openSessions()).toHaveLength(1);
    expect(openSessions()[0]!.title).toBe("feat/x");

    // Archiving it does not bring it back.
    const s = openSessions()[0]!;
    store().putSession({ ...s, runtime: "stopped", archivedAt: store().nowIso() });
    await lifecycle().tick();
    expect(commandsOf(h.host, "session.start")).toHaveLength(1);
  });

  it("does not start one when a session already uses the worktree", async () => {
    expect((await h.t.admin("POST", `/api/projects/${h.project.id}/refresh`)).status).toBe(200);
    const ws = store().workspaceByPath(h.creds.hostId, WT)!;
    const r = await h.t.admin("POST", "/api/sessions", {
      projectId: h.project.id,
      workspace: { existingId: ws.id },
    });
    expect(r.status).toBe(202);
    await until(() => commandsOf(h.host, "session.start").length === 1);
    await lifecycle().tick();
    expect(commandsOf(h.host, "session.start")).toHaveLength(1);
  });

  it("ensures again once a worktree was archived and came back", async () => {
    await lifecycle().tick();
    await until(() => commandsOf(h.host, "session.start").length === 1);
    const s = openSessions()[0]!;
    store().putSession({ ...s, runtime: "stopped", archivedAt: store().nowIso() });
    const saved = trees;
    trees = trees.filter((t) => t.path !== WT);
    await lifecycle().tick();
    trees = saved;
    await lifecycle().tick();
    await until(() => commandsOf(h.host, "session.start").length === 2);
  });

  it("is off unless the project opts in", async () => {
    await patch({ ensureSessions: false });
    await lifecycle().tick();
    expect(commandsOf(h.host, "session.start")).toHaveLength(0);
  });
});

describe("remove landed", () => {
  beforeEach(async () => {
    expect((await patch({ removeLanded: true })).status).toBe(200);
    pr = { state: "MERGED", headRefOid: HEAD };
  });

  const removes = () => commandsOf(h.host, "workspace.remove");

  it("waits for the grace period, then archives sessions and removes the worktree", async () => {
    await lifecycle().tick(1_000);
    expect(removes()).toHaveLength(0);
    await lifecycle().tick(1_000 + LANDED_GRACE_MS - 1);
    expect(removes()).toHaveLength(0);
    await lifecycle().tick(1_000 + LANDED_GRACE_MS);
    expect(removes()).toHaveLength(1);
    expect(removes()[0]).toMatchObject({
      path: WT,
      force: { dirty: false, unmerged: true },
      deleteBranch: true,
    });
    const ws = store().workspaceByPath(h.creds.hostId, WT)!;
    expect(ws.archivedAt).not.toBeNull();
  });

  it("leaves a landed worktree untouched when the project is delisted during the check", async () => {
    await lifecycle().tick(0);
    const project = store().projects.require(h.project.id);
    const prev = h.override!;
    h.override = (cmd, id) => {
      if (cmd.type === "workspace.status") {
        store().putProject({ ...project, catalog: { ...project.catalog, state: "delisted" } });
      }
      return prev(cmd, id);
    };
    await lifecycle().tick(LANDED_GRACE_MS);
    await lifecycle().tick(LANDED_GRACE_MS * 2);
    expect(removes()).toHaveLength(0);
    expect(store().workspaceByPath(h.creds.hostId, WT)?.archivedAt).toBeNull();
  });

  const neverRemoves = async () => {
    await lifecycle().tick(0);
    await lifecycle().tick(LANDED_GRACE_MS * 2);
    expect(removes()).toHaveLength(0);
  };

  it("keeps a worktree whose HEAD is not the merged head", async () => {
    status = { ...status, head: "b".repeat(40) };
    await neverRemoves();
  });

  it("keeps a dirty worktree", async () => {
    status = { ...status, dirty: true, changedFiles: 1 };
    await neverRemoves();
  });

  it("keeps a worktree whose host reports no HEAD", async () => {
    const { head: _head, ...rest } = status;
    status = rest;
    await neverRemoves();
  });

  it("keeps a worktree whose pull request is open", async () => {
    pr = { state: "OPEN", headRefOid: HEAD };
    await neverRemoves();
  });

  it("keeps a worktree with a running session", async () => {
    await lifecycle().tick(0);
    const ws = store().workspaceByPath(h.creds.hostId, WT)!;
    const now = store().nowIso();
    store().putSession({
      id: "ses_running",
      title: "busy",
      subtitle: null,
      hostId: h.creds.hostId,
      workspaceId: ws.id,
      projectId: h.project.id,
      cwd: WT,
      nativeHandle: null,
      profileSnapshot: store().profiles.list()[0]!,
      runtime: "running",
      runtimeDetail: null,
      connectivity: "connected",
      runId: null,
      taskId: null,
      provenance: "created",
      readOnly: false,
      lastActivityAt: now,
      archivedAt: null,
      queue: { steering: [], followUp: [] },
      stats: null,
      lastAssistantText: null,
      createdAt: now,
    });
    await lifecycle().tick(LANDED_GRACE_MS * 2);
    expect(removes()).toHaveLength(0);
  });
});
