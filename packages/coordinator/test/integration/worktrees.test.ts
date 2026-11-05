import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "@switchyard/protocol";
import { makeRepo } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, Integration, tempDir, worktreePaths } from "./harness.js";

/** Spec §19: repo-local worktrees and external discovery, through the coordinator API. */
describe("worktrees via the API", { timeout: 120_000 }, () => {
  let env: Integration;
  let external: string;
  beforeAll(async () => {
    env = await Integration.create();
    external = join(tempDir("sy-int-ext-"), "ext-wt");
  });
  afterAll(async () => {
    await env?.dispose();
    rmSync(join(external, ".."), { recursive: true, force: true });
  });

  let featX: Workspace;

  it("creates a managed worktree at <repo>/.worktrees/feat-x for branch feat/x", async () => {
    const r = await env.api("POST", "/api/workspaces", {
      body: { checkoutId: env.checkoutId, branch: "feat/x" },
    });
    expect(r.status).toBe(201);
    featX = r.body;
    expect(featX.path).toBe(`${env.repo!.path}/.worktrees/feat-x`);
    expect(featX.branch).toBe("feat/x");
    expect(featX.baseBranch).toBe("main");
    expect(featX.provenance).toBe("managed");
    expect(existsSync(join(featX.path, "README.md"))).toBe(true);
    expect(worktreePaths(env.repo!.path)).toContain(featX.path);
    expect(git(featX.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feat/x");
    // The main checkout stays clean: .worktrees/ is ignored locally.
    expect(git(env.repo!.path, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("discovers an external `git worktree add` as discovered", async () => {
    git(env.repo!.path, ["worktree", "add", "-q", "-b", "ext/branch", external]);
    const r = await env.ok("POST", `/api/projects/${env.project.id}/refresh`);
    expect(r.errors).toEqual([]);
    const ws = (r.workspaces as Workspace[]).find((w) => w.path === external);
    expect(ws).toBeDefined();
    expect(ws!.provenance).toBe("discovered");
    expect(ws!.branch).toBe("ext/branch");
    const list = (await env.ok(
      "GET",
      `/api/workspaces?projectId=${env.project.id}`,
    )) as Workspace[];
    expect(list.map((w) => w.provenance).sort()).toEqual(["discovered", "main", "managed"]);
  });

  it("rejects an invalid branch and a colliding path", async () => {
    const bad = await env.api("POST", "/api/workspaces", {
      body: { checkoutId: env.checkoutId, branch: "bad..name" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("branch_invalid");

    mkdirSync(join(env.repo!.path, ".worktrees", "collide"), { recursive: true });
    writeFileSync(join(env.repo!.path, ".worktrees", "collide", "keep.txt"), "mine\n");
    const collide = await env.api("POST", "/api/workspaces", {
      body: { checkoutId: env.checkoutId, branch: "collide" },
    });
    expect(collide.status).toBe(409);
    expect(collide.body.error.code).toBe("path_collision");
    expect(existsSync(join(env.repo!.path, ".worktrees", "collide", "keep.txt"))).toBe(true);
    const branches = git(env.repo!.path, ["branch", "--list", "collide", "bad..name"]).trim();
    expect(branches).toBe("");
  });

  it("refuses to remove a dirty worktree without force", async () => {
    writeFileSync(join(featX.path, "scratch.txt"), "uncommitted\n");
    const r = await env.api("POST", `/api/workspaces/${featX.id}/remove`, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("workspace_dirty");
    expect(existsSync(join(featX.path, "scratch.txt"))).toBe(true);
    expect(env.c.store.workspaces.get(featX.id)).toBeDefined();
  });

  it("refuses removal while a live session uses the workspace, then removes with force", async () => {
    const { terminal } = env.devices!;
    const s = await env.ok("POST", "/api/sessions", {
      as: terminal,
      body: { projectId: env.project.id, workspace: { existingId: featX.id }, prompt: "" },
    });
    await env.waitSession(s.id, (x) => x.runtime === "idle", "session idle");
    const busy = await env.api("POST", `/api/workspaces/${featX.id}/remove`, {
      body: { force: { dirty: true, unmerged: true } },
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("workspace_active_sessions");
    expect(busy.body.error.details.sessionIds).toEqual([s.id]);
    expect(existsSync(featX.path)).toBe(true);

    // Archive stops the idle Pi; then forced removal deletes the worktree but keeps the branch.
    await env.ok("POST", `/api/sessions/${s.id}/archive`, { as: terminal });
    await env.waitSession(s.id, (x) => x.runtime === "stopped", "stopped");
    const removed = await env.api("POST", `/api/workspaces/${featX.id}/remove`, {
      body: { force: { dirty: true, unmerged: false } },
    });
    expect(removed.status).toBe(200);
    expect(existsSync(featX.path)).toBe(false);
    expect(worktreePaths(env.repo!.path)).not.toContain(featX.path);
    expect(git(env.repo!.path, ["branch", "--list", "feat/x"]).trim()).toContain("feat/x");
    expect(env.c.store.workspaces.get(featX.id)?.archivedAt).not.toBeNull();
  });

  it("removes the external worktree only on request; the main checkout is protected", async () => {
    const ext = env.c.store.workspaces
      .list("project_id = ?", [env.project.id])
      .find((w) => w.path === external)!;
    const main = await env.api("POST", `/api/workspaces/${env.mainWorkspaceId}/remove`, {
      body: {},
    });
    expect(main.status).toBe(403);
    const r = await env.api("POST", `/api/workspaces/${ext.id}/remove`, { body: {} });
    expect(r.status).toBe(200);
    expect(existsSync(external)).toBe(false);
  });

  it("uses the project's worktree folder: worktreeDir 'wt' creates <repo>/wt/feat-x", async () => {
    const repo = makeRepo({ remote: "https://example.invalid/acme/wt-folder.git" });
    try {
      const bad = await env.api("POST", "/api/projects", {
        body: { name: "Escapes", hostId: env.hostId, path: repo.path, worktreeDir: "../x" },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_request");

      const p = await env.api("POST", "/api/projects", {
        body: { name: "Custom folder", hostId: env.hostId, path: repo.path, worktreeDir: "wt" },
      });
      expect(p.status).toBe(201);
      expect(p.body.worktreeDir).toBe("wt");
      const checkoutId = p.body.checkouts[0].id as string;
      const discover = env.hostCommands.filter(
        (c) => c.type === "workspace.discover" && c.checkoutPath === repo.path,
      );
      expect(discover.at(-1)).toMatchObject({ worktreeDir: "wt" });

      const r = await env.api("POST", "/api/workspaces", {
        body: { checkoutId, branch: "feat/x" },
      });
      expect(r.status).toBe(201);
      const ws = r.body as Workspace;
      expect(ws.path).toBe(`${repo.path}/wt/feat-x`);
      expect(ws.provenance).toBe("managed");
      expect(existsSync(join(repo.path, "wt", "feat-x", "README.md"))).toBe(true);
      expect(existsSync(join(repo.path, ".worktrees"))).toBe(false);
      expect(git(repo.path, ["status", "--porcelain"]).trim()).toBe("");
      expect(
        env.hostCommands.find((c) => c.type === "workspace.create" && c.checkoutPath === repo.path),
      ).toMatchObject({ worktreeDir: "wt" });

      // Discovery classifies by the same folder.
      const refreshed = await env.ok("POST", `/api/projects/${p.body.id}/refresh`);
      expect(refreshed.errors).toEqual([]);
      const found = (refreshed.workspaces as Workspace[]).find((w) => w.path === ws.path);
      expect(found?.provenance).toBe("managed");

      // The folder is a project setting: PATCH validates it the same way.
      const patched = await env.api("PATCH", `/api/projects/${p.body.id}`, {
        body: { worktreeDir: "/abs" },
      });
      expect(patched.status).toBe(400);
      const ok = await env.ok("PATCH", `/api/projects/${p.body.id}`, {
        body: { worktreeDir: ".git/worktrees-switchyard" },
      });
      expect(ok.worktreeDir).toBe(".git/worktrees-switchyard");

      await env.ok("POST", `/api/workspaces/${ws.id}/remove`, {
        body: { force: { dirty: true, unmerged: true } },
      });
    } finally {
      repo.cleanup();
    }
  });
});
