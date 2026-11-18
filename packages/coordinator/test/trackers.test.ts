// @module-tag slow
import type { HostCommand, Tracker, TrackerItem } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireService } from "../src/index.js";
import { inScope, issueBranch, mergeSyncResults } from "../src/trackers.js";
import { commandsOf, type Harness, ROOT, setupHarness } from "./task-helpers.js";

const REPO = "acme/app";

function item(n: number, over: Partial<TrackerItem> = {}): TrackerItem {
  return {
    itemId: `I_${n}`,
    repository: REPO,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    assignees: ["me"],
    branches: [],
    pullRequest: null,
    board: null,
    ...over,
  };
}

const board = (status: string | null) => ({
  projectId: "P",
  projectItemId: "PI",
  fieldId: "F",
  status,
  statusOptionId: status === null ? null : `o-${status}`,
  options: [
    { id: "o-Todo", name: "Todo" },
    { id: "o-In progress", name: "In progress" },
    { id: "o-Review", name: "Review" },
  ],
});

function discovered(path: string, branch: string, provenance: "main" | "discovered" | "managed") {
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
let items: TrackerItem[];
let truncated: boolean;
let moves: { status: "moved" } | { status: "skipped"; reason: string };
let worktrees: { path: string; branch: string }[];

beforeEach(async () => {
  h = await setupHarness();
  items = [];
  truncated = false;
  moves = { status: "moved" };
  worktrees = [];
  const p = h.t.c.store.projects.require(h.project.id);
  h.t.c.store.putProject({ ...p, repoIdentity: `https://github.com/${REPO}` });
  h.override = (cmd: HostCommand) => {
    if (cmd.type === "tracker.sync") return { login: "me", items, truncated };
    if (cmd.type === "tracker.prepareBranch") return { ok: true };
    if (cmd.type === "tracker.startIssue") {
      items = items.map((i) => (i.number === cmd.number ? { ...i, branches: [cmd.branch] } : i));
      return { branch: cmd.branch };
    }
    if (cmd.type === "tracker.setStatus") return moves;
    if (cmd.type === "workspace.create") {
      const path = `${ROOT}/.worktrees/${cmd.branch.replaceAll("/", "-")}`;
      worktrees.push({ path, branch: cmd.branch });
      return { path, branch: cmd.branch, baseBranch: cmd.base };
    }
    return undefined;
  };
});

afterEach(async () => {
  await h.t.cleanup();
});

const service = () => requireService(h.t.c.ctx, "trackers");
const store = () => h.t.c.store;
const tracked = (id: string) =>
  store()
    .tasks.list()
    .filter((t) => t.tracker?.trackerId === id);

async function create(body: Record<string, unknown> = {}): Promise<Tracker> {
  const r = await h.t.admin("POST", "/api/trackers", {
    name: "fieldgoal",
    hostId: h.creds.hostId,
    owner: "acme",
    ...body,
  });
  expect(r.status).toBe(201);
  // The create route starts a sync in the background; let it finish.
  return service().sync(r.body.id);
}

describe("tracker sync", () => {
  it("creates one Backlog task per assigned issue and is idempotent", async () => {
    items = [item(1), item(2)];
    const t = await create();
    expect(t.login).toBe("me");
    expect(t.lastError).toBeNull();
    const tasks = tracked(t.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      state: "backlog",
      title: "Issue 1",
      githubIssue: { url: `https://github.com/${REPO}/issues/1` },
      tracker: { itemId: "I_1", number: 1, branch: null, workspaceId: null },
    });
    const events = () =>
      (store().db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const before = events();
    await service().sync(t.id);
    expect(events()).toBe(before);
  });

  it("adopts an existing task for the same issue", async () => {
    const r = await h.t.admin("POST", "/api/tasks", {
      projectId: h.project.id,
      githubIssueUrl: `https://github.com/${REPO}/issues/1`,
    });
    items = [item(1)];
    const t = await create();
    expect(tracked(t.id).map((x) => x.id)).toEqual([r.body.id]);
  });

  it("drops vanished Backlog tasks but keeps ones with work", async () => {
    items = [item(1), item(2)];
    const t = await create();
    const two = tracked(t.id).find((x) => x.tracker!.number === 2)!;
    store().putTask({ ...two, state: "in_progress" });
    items = [];
    truncated = true;
    await service().sync(t.id);
    expect(tracked(t.id)).toHaveLength(2);
    truncated = false;
    await service().sync(t.id);
    expect(tracked(t.id).map((x) => x.tracker!.number)).toEqual([2]);
  });

  it("includes repositories of other owners", async () => {
    store().putProject({
      ...store().projects.require(h.project.id),
      id: "prj_lib",
      name: "Lib",
      repoIdentity: "https://github.com/other/lib",
    });
    const base = h.override!;
    const lib = item(9, {
      itemId: "I_9",
      repository: "other/lib",
      url: "https://github.com/other/lib/issues/9",
    });
    h.override = (cmd, id) =>
      cmd.type === "tracker.sync" && cmd.repositories?.[0] === "other/lib"
        ? { login: "me", items: [lib], truncated: false }
        : base(cmd, id);
    items = [item(1)];
    const t = await create({ extraRepositories: ["other/lib"] });
    const syncs = commandsOf(h.host, "tracker.sync");
    expect(syncs).toHaveLength(2);
    expect(syncs[1]).toMatchObject({ owner: "acme", repositories: ["other/lib"] });
    expect(
      tracked(t.id)
        .map((x) => x.projectId)
        .sort(),
    ).toEqual([h.project.id, "prj_lib"].sort());
    const view = store()
      .views.list()
      .find((v) => v.trackerId === t.id)!;
    expect([...(view.projectIds ?? [])].sort()).toEqual([h.project.id, "prj_lib"].sort());
  });

  it("fails the sync when the extra request fails", async () => {
    items = [item(1)];
    const t = await create();
    expect(tracked(t.id)).toHaveLength(1);
    const base = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "tracker.sync" && cmd.repositories?.[0] === "other/lib"
        ? { __error: { code: "internal", message: "boom" } }
        : base(cmd, id);
    items = [];
    await h.t.admin("PATCH", `/api/trackers/${t.id}`, { extraRepositories: ["other/lib"] });
    const after = await service().sync(t.id);
    expect(after.lastError).toContain("boom");
    expect(tracked(t.id)).toHaveLength(1);
  });

  it("merges sync results and scopes extra repositories", () => {
    const a = item(1);
    const merged = mergeSyncResults([
      { login: "me", items: [a], truncated: false },
      { login: "other", items: [a, item(2)], truncated: true },
    ]);
    expect(merged.login).toBe("me");
    expect(merged.items.map((i) => i.number)).toEqual([1, 2]);
    expect(merged.truncated).toBe(true);
    const project = store().projects.require(h.project.id);
    const t = { owner: "acme", repositories: null, extraRepositories: ["Other/Lib"] };
    expect(inScope(t, { ...project, repoIdentity: "https://github.com/other/lib" })).toBe(true);
    expect(inScope(t, { ...project, repoIdentity: "https://github.com/other/x" })).toBe(false);
  });

  it("reports issues in repositories without a project", async () => {
    items = [item(1, { repository: "acme/other", url: "https://github.com/acme/other/issues/1" })];
    const t = await create();
    expect(t.lastError).toBe("1 issue is in repositories with no project here");
    expect(tracked(t.id)).toHaveLength(0);
  });

  it("creates the worktree for a linked branch once and links it", async () => {
    items = [item(1, { branches: ["feat/x"] })];
    const t = await create();
    expect(commandsOf(h.host, "tracker.prepareBranch")).toEqual([
      expect.objectContaining({ checkoutPath: ROOT, branch: "feat/x" }),
    ]);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(1);
    const [task] = tracked(t.id);
    const ws = store().workspaces.require(task!.tracker!.workspaceId!);
    expect(ws).toMatchObject({ branch: "feat/x", path: `${ROOT}/.worktrees/feat-x` });
    expect(task!.tracker!.branch).toBe("feat/x");
    await service().sync(t.id);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(1);
  });

  it("links a worktree that already exists instead of creating one", async () => {
    const base = h.override!;
    const wt = `${ROOT}/.worktrees/feat-x`;
    h.override = (cmd, id) =>
      cmd.type === "workspace.discover"
        ? [discovered(ROOT, "main", "main"), discovered(wt, "feat/x", "discovered")]
        : base(cmd, id);
    items = [item(1, { branches: ["feat/x"] })];
    const t = await create();
    expect(commandsOf(h.host, "tracker.prepareBranch")).toHaveLength(0);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    const [task] = tracked(t.id);
    expect(task!.tracker!.workspaceId).toBe(store().workspaceByPath(h.creds.hostId, wt)!.id);
    expect(t.lastError).toBeNull();
  });

  it("rescans a checkout once per sync", async () => {
    const base = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "workspace.discover"
        ? [
            discovered(ROOT, "main", "main"),
            ...worktrees.map((w) => discovered(w.path, w.branch, "managed")),
          ]
        : base(cmd, id);
    items = [item(1, { branches: ["feat/a"] }), item(2, { branches: ["feat/b"] })];
    const before = commandsOf(h.host, "workspace.discover").length;
    await create();
    expect(commandsOf(h.host, "workspace.discover").length - before).toBe(1);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(2);
  });

  it("makes no worktree for a merged issue", async () => {
    items = [
      item(1, {
        branches: ["feat/x"],
        pullRequest: {
          number: 3,
          state: "MERGED",
          url: `https://github.com/${REPO}/pull/3`,
          headRefName: "feat/x",
        },
      }),
    ];
    await create();
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
  });

  it("keeps a view of its projects, and owns its project list", async () => {
    const other = await h.t.admin("POST", "/api/views", { name: "FieldGoal" });
    const t = await create();
    const view = store().views.require(other.body.id);
    expect(view).toMatchObject({ trackerId: t.id, projectIds: [h.project.id] });
    const r = await h.t.admin("PATCH", `/api/views/${view.id}`, { projectIds: null });
    expect(r.status).toBe(409);
    expect((await h.t.admin("PATCH", `/api/views/${view.id}`, { hostIds: null })).status).toBe(200);
  });

  it("creates its view when none exists", async () => {
    const t = await create();
    const view = store()
      .views.list()
      .find((v) => v.trackerId === t.id);
    expect(view).toMatchObject({ name: "fieldgoal", mode: "all", projectIds: [h.project.id] });
  });

  it("delete strips its tasks and releases its view", async () => {
    items = [item(1)];
    const t = await create();
    expect((await h.t.admin("DELETE", `/api/trackers/${t.id}`)).status).toBe(200);
    expect(
      store()
        .tasks.list()
        .every((x) => x.tracker === undefined),
    ).toBe(true);
    expect(
      store()
        .views.list()
        .find((v) => v.name === "fieldgoal")!.trackerId,
    ).toBeNull();
    expect(store().trackers.list()).toHaveLength(0);
  });

  it("explains a host without tracker support", async () => {
    await h.host.close();
    await h.host.open({ features: ["agentRequests.v1", "policies.v1"] });
    const t = await create();
    expect(t.lastError).toMatch(/does not support trackers; upgrade its host agent/);
  });

  it("rejects duplicate names", async () => {
    await create();
    const r = await h.t.admin("POST", "/api/trackers", {
      name: "FIELDGOAL",
      hostId: h.creds.hostId,
      owner: "acme",
    });
    expect(r.status).toBe(409);
  });
});

describe("start work", () => {
  it("creates the linked branch with gh, then syncs it into a worktree", async () => {
    items = [item(4, { title: "Fix: the login page!" })];
    const t = await create();
    const [task] = tracked(t.id);
    const r = await h.t.admin("POST", `/api/tasks/${task!.id}/tracker/start`);
    expect(r.status).toBe(200);
    expect(commandsOf(h.host, "tracker.startIssue")[0]).toMatchObject({
      repository: REPO,
      number: 4,
      branch: "4-fix-the-login-page",
      base: "main",
    });
    expect(r.body.tracker.branch).toBe("4-fix-the-login-page");
    expect((await h.t.admin("POST", `/api/tasks/${task!.id}/tracker/start`)).status).toBe(409);
  });

  it("names branches from the number and title", () => {
    expect(issueBranch(7, "  Add CSV export (v2)  ")).toBe("7-add-csv-export-v2");
    expect(issueBranch(8, "!!!")).toBe("8");
  });
});

describe("board write-back", () => {
  const withBoard = {
    board: { projectNumber: 5, onStart: "In progress", onReview: "Review" },
    writeBack: true,
  };

  it("moves the card once a worktree exists, once", async () => {
    items = [item(1, { branches: ["feat/x"], board: board("Todo") })];
    const t = await create(withBoard);
    const moved = commandsOf(h.host, "tracker.setStatus");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      optionId: "o-In progress",
      expectedOptionId: "o-Todo",
      login: "me",
      allowShared: true,
    });
    expect(tracked(t.id)[0]!.tracker!.board!.status).toBe("In progress");
    // A person moves it back on GitHub: Switchyard does not fight them.
    await service().sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(1);
  });

  it("moves to review once a pull request is open", async () => {
    items = [
      item(1, {
        branches: ["feat/x"],
        board: board("In progress"),
        pullRequest: {
          number: 3,
          state: "OPEN",
          url: `https://github.com/${REPO}/pull/3`,
          headRefName: "feat/x",
        },
      }),
    ];
    await create(withBoard);
    expect(commandsOf(h.host, "tracker.setStatus")[0]).toMatchObject({ optionId: "o-Review" });
  });

  it("retries a stale move on the next sync, but not a shared one", async () => {
    items = [item(1, { branches: ["feat/x"], board: board("Todo") })];
    moves = { status: "skipped", reason: "stale" };
    const t = await create(withBoard);
    await service().sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(2);
    moves = { status: "skipped", reason: "shared" };
    await service().sync(t.id);
    await service().sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(3);
  });

  it("does nothing without write-back", async () => {
    items = [item(1, { branches: ["feat/x"], board: board("Todo") })];
    await create({ board: withBoard.board });
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(0);
  });

  it("sets a column by hand and maps skips to conflicts", async () => {
    items = [item(1, { board: board("Todo") })];
    const t = await create(withBoard);
    const [task] = tracked(t.id);
    const path = `/api/tasks/${task!.id}/tracker/status`;
    const ok = await h.t.admin("POST", path, { status: "review" });
    expect(ok.status).toBe(200);
    expect(ok.body.tracker.board.status).toBe("Review");
    expect((await h.t.admin("POST", path, { status: "Nope" })).status).toBe(400);
    moves = { status: "skipped", reason: "stale" };
    const stale = await h.t.admin("POST", path, { status: "Todo" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toBe("The card moved on GitHub; refresh and try again");
    await h.t.admin("PATCH", `/api/trackers/${t.id}`, { writeBack: false });
    expect((await h.t.admin("POST", path, { status: "Todo" })).status).toBe(403);
  });
});
