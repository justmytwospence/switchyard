import { expect, it } from "vitest";
import { startCoordinator } from "./helpers.js";

it("rejects issue imports without writes while allowing ordinary task creation", async () => {
  const t = await startCoordinator({ dispatcher: { tickMs: 0 }, schedulerTickMs: 0 });
  try {
    const now = "2026-01-01T00:00:00.000Z";
    t.c.store.putProject({
      id: "project",
      name: "project",
      repoIdentity: "https://github.com/Owner/Repo",
      defaultHostId: null,
      defaultProfileId: null,
      maxConcurrentRuns: 1,
      automationEnabled: false,
      setupCommand: null,
      checks: [],
      workspaceSharing: "single_writer",
      worktreeDir: ".worktrees",
      createdAt: now,
      updatedAt: now,
    });
    const { store } = t.c;
    const tasks = store.tasks.list();
    const events = store.db.prepare("SELECT * FROM events").all();
    const subscriptions = store.db.prepare("SELECT * FROM task_subscriptions").all();

    const rejected = await t.admin("POST", "/api/tasks", {
      projectId: "project",
      githubIssueUrl: "https://github.com/Owner/Repo/issues/17",
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual({
      error: {
        code: "unsupported_capability",
        message: "GitHub issue task import is not enabled yet.",
      },
    });
    expect(store.tasks.list()).toEqual(tasks);
    expect(store.db.prepare("SELECT * FROM events").all()).toEqual(events);
    expect(store.db.prepare("SELECT * FROM task_subscriptions").all()).toEqual(subscriptions);

    const created = await t.admin("POST", "/api/tasks", { projectId: "project", title: "Work" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ projectId: "project", title: "Work" });
    expect(store.tasks.require(created.body.id)).toMatchObject({ title: "Work" });
  } finally {
    await t.cleanup();
  }
});
