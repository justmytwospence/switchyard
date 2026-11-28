// @module-tag slow
import type { GitHubSource, HostCommand, Scope, SyncedIssue, Task } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireService } from "../src/index.js";
import { inScope, issueBranch, mergeSyncResults, repositoryInScope } from "../src/scope-sources.js";
import { enrollHost, FakeHost, until } from "./helpers.js";
import {
  commandsOf,
  type Harness,
  HostState,
  ROOT,
  setupHarness,
  smartHandler,
} from "./task-helpers.js";

const REPO = "acme/app";

function item(n: number, over: Partial<SyncedIssue> = {}): SyncedIssue {
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
let items: SyncedIssue[];
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

const service = () => requireService(h.t.c.ctx, "scopeSources");
const store = () => h.t.c.store;
const tracked = (id: string) => store().issues.list("scope_id = ?", [id], "created_at, rowid");

/** A GitHub scope as these tests read it: its id and name beside its source's fields. */
type Sourced = GitHubSource & { id: string; name: string };
const flat = (s: Scope): Sourced => ({ ...s.source!, id: s.id, name: s.name });
const sync = async (id: string): Promise<Sourced> => flat(await service().sync(id));
/** POST /api/scopes with a GitHub source; `name` names the scope, the rest is the source. */
const post = ({ name = "fieldgoal", ...source }: Record<string, unknown> = {}) =>
  h.t.admin("POST", "/api/scopes", {
    name,
    source: { hostId: h.creds.hostId, owner: "acme", ...source },
  });
const patchSource = (id: string, source: Record<string, unknown>) =>
  h.t.admin("PATCH", `/api/scopes/${id}`, { source });

async function create(body: Record<string, unknown> = {}): Promise<Sourced> {
  const r = await post(body);
  expect(r.status).toBe(201);
  // The create route starts a sync in the background; let it finish.
  return sync(r.body.id);
}

describe("issue description", () => {
  it("reads a stored locator without syncing or changing state", async () => {
    items = [item(1)];
    const scope = await create({ enabled: false });
    const issue = tracked(scope.id)[0]!;
    const previous = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "tracker.describeIssue"
        ? { body: "markdown", truncated: false }
        : previous(cmd, id);
    const before = (store().db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number })
      .n;
    const syncCount = commandsOf(h.host, "tracker.sync").length;
    const response = await h.t.admin(
      "GET",
      `/api/issues/${encodeURIComponent(issue.id)}/description`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (await h.t.api("GET", `/api/issues/${encodeURIComponent(issue.id)}/description`)).status,
    ).toBe(401);
    expect(response.body).toEqual({ body: "markdown", truncated: false });
    expect(commandsOf(h.host, "tracker.describeIssue")).toEqual([
      expect.objectContaining({ repository: REPO, number: 1 }),
    ]);
    expect(commandsOf(h.host, "tracker.sync")).toHaveLength(syncCount);
    expect((store().db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(
      before,
    );
    expect(store().tasks.list()).toHaveLength(0);
    expect((await h.t.admin("GET", "/api/issues/missing/description")).status).toBe(404);
  });

  it("rejects malformed replies and changed source associations", async () => {
    items = [item(1)];
    const scope = await create();
    const issue = tracked(scope.id)[0]!;
    const previous = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "tracker.describeIssue"
        ? { body: "x".repeat(32769), truncated: false }
        : previous(cmd, id);
    await expect(service().describeIssue(issue.id)).rejects.toThrow();
    h.override = (cmd, id) => {
      if (cmd.type !== "tracker.describeIssue") return previous(cmd, id);
      const current = store().scopes.require(scope.id);
      store().scopes.upsert({ ...current, source: { ...current.source!, hostId: "other" } });
      return { body: "secret", truncated: false };
    };
    await expect(service().describeIssue(issue.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("scope source sync", () => {
  it("tracks one issue per assigned issue, creates no tasks and is idempotent", async () => {
    items = [item(1), item(2)];
    const t = await create();
    expect(t.login).toBe("me");
    expect(t.lastError).toBeNull();
    const issues = tracked(t.id);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      id: `${t.id}:I_1`,
      title: "Issue 1",
      url: `https://github.com/${REPO}/issues/1`,
      itemId: "I_1",
      number: 1,
      projectId: h.project.id,
      branch: null,
      workspaceId: null,
    });
    expect(store().tasks.list()).toHaveLength(0);
    const events = () =>
      (store().db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const before = events();
    await sync(t.id);
    expect(events()).toBe(before);
  });

  it("matches the listed project at a recycled slug even if it has no checkout", async () => {
    const old = store().projects.require(h.project.id);
    store().putProject({ ...old, catalog: { state: "legacy" } });
    const id = "prj_recycled_slug";
    store().putProject({
      ...old,
      id,
      defaultHostId: null,
      catalog: { state: "listed", authority: "github.com", externalId: "recycled", fullName: REPO },
    });
    items = [item(1, { branches: ["topic"] })];
    const scope = await create({ worktrees: true });
    expect(store().scopes.require(scope.id).projectIds).toEqual([id]);
    expect(tracked(scope.id)).toEqual([
      expect.objectContaining({ projectId: id, workspaceId: null }),
    ]);
    const r = await h.t.admin(
      "POST",
      `/api/issues/${encodeURIComponent(tracked(scope.id)[0]!.id)}/open`,
      {},
    );
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Prepare a checkout/);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
    expect(commandsOf(h.host, "tracker.prepareBranch")).toHaveLength(0);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
  });

  it("drops vanished issues unless the result was truncated", async () => {
    items = [item(1), item(2)];
    const t = await create();
    items = [item(2)];
    truncated = true;
    await sync(t.id);
    expect(tracked(t.id)).toHaveLength(2);
    truncated = false;
    await sync(t.id);
    expect(tracked(t.id).map((x) => x.number)).toEqual([2]);
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
    const scope = store().scopes.require(t.id);
    expect([...(scope.projectIds ?? [])].sort()).toEqual([h.project.id, "prj_lib"].sort());
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
    await patchSource(t.id, { extraRepositories: ["other/lib"] });
    const after = await sync(t.id);
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
    expect(inScope(t, { ...project, repoIdentity: "local:abc" })).toBe(false);
    expect(repositoryInScope(t, "ACME/app")).toBe(true);
    expect(repositoryInScope(t, "other/lib")).toBe(true);
    expect(repositoryInScope(t, "zzz/x")).toBe(false);
    expect(repositoryInScope({ ...t, repositories: ["acme/app"] }, "acme/b")).toBe(false);
  });

  it("follows a board: one request, scoped to its repositories", async () => {
    items = [item(1), item(2, { repository: "zzz/x", url: "https://github.com/zzz/x/issues/2" })];
    const t = await create({
      board: { projectNumber: 5, backlog: ["Backlog"] },
      follow: "board",
      extraRepositories: ["other/lib"],
    });
    const syncs = commandsOf(h.host, "tracker.sync");
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ follow: "board", backlog: ["Backlog"], repositories: null });
    expect(tracked(t.id)).toHaveLength(1);
    expect(t.lastError).toBeNull();
  });

  it("passes the priority field and keeps priority, parent and sub-issues", async () => {
    const parent = { number: 39, title: "Epic", url: `https://github.com/${REPO}/issues/39` };
    items = [
      item(1, {
        board: { ...board("Todo"), priority: { name: "P1", rank: 1 } },
        parent,
        subIssues: { total: 3, completed: 1 },
      }),
    ];
    const t = await create({ board: { projectNumber: 5, priorityField: "Priority" } });
    expect(commandsOf(h.host, "tracker.sync")[0]).toMatchObject({
      board: { priorityField: "Priority" },
    });
    expect(tracked(t.id)[0]).toMatchObject({
      board: { priority: { name: "P1", rank: 1 } },
      parent,
      subIssues: { total: 3, completed: 1 },
    });
  });

  it("rejects following a board without a board", async () => {
    const r = await post({ name: "x", follow: "board" });
    expect(r.status).toBe(400);
  });

  it("explains a host too old to follow a board", async () => {
    await h.host.close();
    await h.host.open({ features: ["agentRequests.v1", "policies.v1", "trackers.v1"] });
    const t = await create({ board: { projectNumber: 5 }, follow: "board" });
    expect(t.lastError).toMatch(/does not support following a board or backlog columns/);
  });

  it("reports issues in repositories without a project", async () => {
    items = [item(1, { repository: "acme/other", url: "https://github.com/acme/other/issues/1" })];
    const t = await create();
    expect(t.lastError).toBe("1 issue is in repositories with no project here: acme/other");
    expect(tracked(t.id)).toHaveLength(0);
  });

  it("creates the worktree for a linked branch once and links it", async () => {
    items = [item(1, { branches: ["feat/x"] })];
    const t = await create();
    expect(commandsOf(h.host, "tracker.prepareBranch")).toEqual([
      expect.objectContaining({ checkoutPath: ROOT, branch: "feat/x" }),
    ]);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(1);
    const [issue] = tracked(t.id);
    const ws = store().workspaces.require(issue!.workspaceId!);
    expect(ws).toMatchObject({ branch: "feat/x", path: `${ROOT}/.worktrees/feat-x` });
    expect(issue!.branch).toBe("feat/x");
    await sync(t.id);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(1);
  });

  it("never makes a worktree when the source only watches", async () => {
    items = [item(1, { branches: ["feat/x"] })];
    const t = await create({ worktrees: false });
    expect(commandsOf(h.host, "tracker.prepareBranch")).toHaveLength(0);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    const [issue] = tracked(t.id);
    expect(issue?.workspaceId ?? null).toBeNull();
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
    const [issue] = tracked(t.id);
    expect(issue!.workspaceId).toBe(store().workspaceByPath(h.creds.hostId, wt)!.id);
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

  it("keeps the scope's projects in step with its repositories", async () => {
    const t = await create();
    expect(store().scopes.require(t.id)).toMatchObject({
      name: "fieldgoal",
      mode: "all",
      projectIds: [h.project.id],
    });
    // A repository of the owner that becomes a project joins at the next sync.
    store().putProject({
      ...store().projects.require(h.project.id),
      id: "prj_more",
      name: "More",
      repoIdentity: "https://github.com/acme/more",
    });
    await sync(t.id);
    expect([...(store().scopes.require(t.id).projectIds ?? [])].sort()).toEqual(
      [h.project.id, "prj_more"].sort(),
    );
    // GitHub keeps the list: it cannot be edited, the rest can.
    expect((await h.t.admin("PATCH", `/api/scopes/${t.id}`, { projectIds: null })).status).toBe(
      409,
    );
    expect((await h.t.admin("PATCH", `/api/scopes/${t.id}`, { hostIds: null })).status).toBe(200);
  });

  it("a sync that changes only lastSyncedAt appends no event", async () => {
    items = [item(1)];
    const t = await create();
    const events = () =>
      (
        store()
          .db.prepare(
            "SELECT COUNT(*) AS n FROM events WHERE type IN ('scope.updated', 'issue.updated')",
          )
          .get() as { n: number }
      ).n;
    const before = events();
    h.t.clock.advance(120_000);
    const after = await sync(t.id);
    expect(after.lastSyncedAt).not.toBe(t.lastSyncedAt);
    expect(store().scopes.require(t.id).source?.lastSyncedAt).toBe(after.lastSyncedAt);
    expect(events()).toBe(before);
    // An error is a change clients must see.
    await h.host.close();
    await sync(t.id);
    expect(events()).toBe(before + 1);
  });

  it("explains a host without GitHub issue sync", async () => {
    await h.host.close();
    await h.host.open({ features: ["agentRequests.v1", "policies.v1"] });
    const t = await create();
    expect(t.lastError).toMatch(/does not support GitHub issue sync; upgrade its host agent/);
  });

  it("rejects duplicate names", async () => {
    await create();
    const r = await post({ name: "FIELDGOAL" });
    expect(r.status).toBe(409);
  });
});

async function secondHost(opts: { defaultHost: boolean }) {
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
  if (opts.defaultHost) {
    store().putProject({
      ...store().projects.require(h.project.id),
      defaultHostId: creds2.hostId,
    });
  }
  return host2;
}

describe("open", () => {
  it("rejects a registered workspace on the proposed unlinked branch", async () => {
    items = [item(42, { title: "Collision" })];
    const t = await create();
    const ws = await h.t.admin("POST", "/api/workspaces", {
      checkoutId: h.project.checkouts[0]!.id,
      branch: "42-collision",
    });
    expect(ws.status).toBe(201);
    const [issue] = tracked(t.id);
    const r = await h.t.admin("POST", `/api/issues/${encodeURIComponent(issue!.id)}/open`, {});
    expect(r.status).toBe(409);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
  });

  it("creates the linked branch with gh, then opens a session in its worktree", async () => {
    items = [item(4, { title: "Fix: the login page!" })];
    const t = await create();
    const [issue] = tracked(t.id);
    const r = await h.t.admin("POST", `/api/issues/${encodeURIComponent(issue!.id)}/open`, {});
    expect(r.status).toBe(202);
    expect(commandsOf(h.host, "tracker.startIssue")[0]?.strict).toBeUndefined();
    expect(commandsOf(h.host, "tracker.startIssue")[0]).toMatchObject({
      repository: REPO,
      number: 4,
      branch: "4-fix-the-login-page",
      base: "main",
    });
    expect(r.body).toMatchObject({ created: true, session: { title: "#4 Fix: the login page!" } });
    expect(commandsOf(h.host, "workspace.create")).toEqual([
      expect.objectContaining({ branch: "4-fix-the-login-page" }),
    ]);
    expect(store().issues.require(issue!.id).branch).toBe("4-fix-the-login-page");
  });

  it("returns the existing primary session the second time", async () => {
    items = [item(6, { title: "Again" })];
    const t = await create();
    const [issue] = tracked(t.id);
    const path = `/api/issues/${encodeURIComponent(issue!.id)}/open`;
    const first = await h.t.admin("POST", path, {});
    await until(() => store().sessions.require(first.body.session.id).workspaceId !== null);
    const second = await h.t.admin("POST", path, {});
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, session: { id: first.body.session.id } });
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(1);
  });

  it("works without a checkout on the source's host", async () => {
    items = [item(5, { title: "Local only" })];
    const t = await create();
    const host2 = await secondHost({ defaultHost: true });
    store().checkouts.delete(h.project.checkouts[0]!.id);
    const [issue] = tracked(t.id);
    const r = await h.t.admin("POST", `/api/issues/${encodeURIComponent(issue!.id)}/open`, {});
    expect(r.status).toBe(202);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
    expect(store().issues.require(issue!.id).branch).toBe(issueBranch(5, "Local only"));
    await until(() => commandsOf(host2, "workspace.create").length === 1);
    await host2.close();
  });

  it("passes the prompt to the new session", async () => {
    items = [item(8, { title: "Prompted" })];
    const t = await create();
    const [issue] = tracked(t.id);
    const r = await h.t.admin("POST", `/api/issues/${encodeURIComponent(issue!.id)}/open`, {
      prompt: "Do the thing",
    });
    expect(r.status).toBe(202);
    await until(() =>
      commandsOf(h.host, "session.start").some((c) => c.initialPrompt === "Do the thing"),
    );
  });

  it("names branches from the number and title", () => {
    expect(issueBranch(7, "  Add CSV export (v2)  ")).toBe("7-add-csv-export-v2");
    expect(issueBranch(8, "!!!")).toBe("8");
  });
});

const repoIssues = () => `/api/projects/${h.project.id}/issues`;
const repoOpen = (number: number) => `${repoIssues()}/${number}/open`;
const trackedOpen = (id: string) => `/api/issues/${encodeURIComponent(id)}/open`;
const sessionWork = (id: string) => `/api/sessions/${id}/issue-work`;

async function enableRepoIssues(host = h.host) {
  await host.close();
  await host.open({
    features: [
      "agentRequests.v1",
      "policies.v1",
      "trackers.v1",
      "trackers.board.v1",
      "trackers.description.v1",
      "trackers.repositoryIssues.v1",
    ],
  });
}

function serveRepoIssues(state: "OPEN" | "CLOSED" = "OPEN") {
  const previous = h.override!;
  h.override = (cmd, id) => {
    if (cmd.type === "tracker.repoIssue") {
      const issue = items.find((i) => i.number === cmd.number);
      return issue ? { state, issue } : { __error: { code: "not_found", message: "missing" } };
    }
    if (cmd.type === "tracker.repoIssuesPage") return { items, nextCursor: null };
    return previous(cmd, id);
  };
}

describe("shared issue work", () => {
  it("requires an authenticated project-bound fresh locator and an open, unmerged issue", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(10)];
    const open = (expectedNodeId: string) => h.t.admin("POST", repoOpen(10), { expectedNodeId });
    expect((await h.t.api("POST", repoOpen(10), { expectedNodeId: "I_10" })).status).toBe(401);
    expect((await h.t.admin("POST", repoOpen(10), {})).status).toBe(400);
    expect(
      (await h.t.admin("POST", repoOpen(10), { expectedNodeId: "I_10", repository: "other/repo" }))
        .status,
    ).toBe(400);
    expect(
      (await h.t.admin("POST", "/api/projects/nope/issues/10/open", { expectedNodeId: "I_10" }))
        .status,
    ).toBe(404);
    expect((await open("stale-id")).status).toBe(409);
    items = [item(10, { repository: "other/repo" })];
    expect((await open("I_10")).status).toBe(409);
    items = [
      item(10, {
        pullRequest: {
          number: 123,
          state: "MERGED",
          url: `https://github.com/${REPO}/pull/123`,
          headRefName: "merged",
        },
      }),
    ];
    expect((await open("I_10")).status).toBe(409);
    items = [];
    expect((await open("I_10")).status).toBe(409);
    items = [item(10)];
    serveRepoIssues("CLOSED");
    expect((await open("I_10")).status).toBe(409);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
    expect(commandsOf(h.host, "tracker.prepareBranch")).toHaveLength(0);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    expect(store().listIssueWork(h.project.id)).toEqual([]);
  });

  it("serializes repo and board starts, reuses the pending session, and reconciles attachment", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(12, { title: "Start me", board: board("Todo") })];
    const firstScope = await create({ name: "first", worktrees: false });
    const otherScope = await create({ name: "other", worktrees: false });
    const [firstIssue] = tracked(firstScope.id);
    const [otherIssue] = tracked(otherScope.id);
    const gh = Promise.withResolvers<void>();
    const workspace = Promise.withResolvers<void>();
    const previous = h.override!;
    h.override = async (cmd, id) => {
      if (cmd.type === "tracker.startIssue") await gh.promise;
      if (cmd.type === "workspace.create") await workspace.promise;
      return previous(cmd, id);
    };
    const syncCount = commandsOf(h.host, "tracker.sync").length;
    const repo = h.t.admin("POST", repoOpen(12), { expectedNodeId: "I_12", prompt: "only once" });
    try {
      await until(() => commandsOf(h.host, "tracker.startIssue").length === 1);
      const trackedRequest = h.t.admin("POST", trackedOpen(firstIssue!.id), {
        prompt: "do not replay",
      });
      gh.resolve();
      const [started, reused] = await Promise.all([repo, trackedRequest]);
      expect(started.status).toBe(202);
      expect(reused.status).toBe(200);
      const id = started.body.session.id;
      expect(reused.body).toMatchObject({ created: false, session: { id, workspaceId: null } });
      expect(commandsOf(h.host, "tracker.startIssue")).toEqual([
        expect.objectContaining({ strict: true, branch: "12-start-me" }),
      ]);
      expect(commandsOf(h.host, "tracker.prepareBranch")).toEqual([
        expect.objectContaining({ strict: true, branch: "12-start-me" }),
      ]);
      expect(commandsOf(h.host, "tracker.sync")).toHaveLength(syncCount);
      expect(store().getIssueWork(h.project.id, "I_12")).toMatchObject({ pendingSessionId: id });
      expect((await h.t.api("GET", sessionWork(id))).status).toBe(401);
      expect((await h.t.admin("GET", sessionWork(id))).body).toMatchObject({
        itemId: "I_12",
        sessionId: id,
        workspaceId: null,
        board: null,
      });
      expect((await h.t.admin("GET", repoIssues())).body.items[0]).toMatchObject({ sessionId: id });
      items = items.map((i) => ({ ...i, title: "Renamed on GitHub" }));
      const renamed = await h.t.admin("POST", repoOpen(12), {
        expectedNodeId: "I_12",
        prompt: "still no",
      });
      expect(renamed.body).toMatchObject({ created: false, session: { id } });
      workspace.resolve();
      await until(() => commandsOf(h.host, "session.start").length === 1);
      const workspaceId = store().sessions.require(id).workspaceId;
      expect(workspaceId).not.toBeNull();
      expect(store().getIssueWork(h.project.id, "I_12")).toMatchObject({
        workspaceId,
        pendingSessionId: null,
        title: "Renamed on GitHub",
      });
      expect(store().issues.require(otherIssue!.id)).toMatchObject({
        branch: "12-start-me",
        workspaceId,
        board: board("Todo"),
      });
      expect(commandsOf(h.host, "session.start")[0]?.initialPrompt).toBe("only once");
      expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(0);
      await h.t.admin("DELETE", `/api/scopes/${firstScope.id}`);
      await h.t.admin("DELETE", `/api/scopes/${otherScope.id}`);
      expect((await h.t.admin("GET", sessionWork(id))).body).toMatchObject({
        itemId: "I_12",
        sessionId: id,
        workspaceId,
        board: null,
      });
    } finally {
      gh.resolve();
      workspace.resolve();
      await repo;
    }
  });

  it("rereads the remote and reuses a branch after a lost start receipt and a failed pre-workspace session", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(14)];
    const scope = await create({ worktrees: false });
    const trackedPath = trackedOpen(tracked(scope.id)[0]!.id);
    const previous = h.override!;
    h.override = (cmd, id) => {
      const result = previous(cmd, id);
      if (cmd.type === "tracker.startIssue")
        return { __error: { code: "timeout", message: "receipt lost" } };
      if (cmd.type === "workspace.create")
        return { __error: { code: "conflict", message: "worktree failed" } };
      return result;
    };
    const uncertain = await h.t.admin("POST", repoOpen(14), { expectedNodeId: "I_14" });
    expect(uncertain.body.error.code).toBe("timeout");
    expect(store().getIssueWork(h.project.id, "I_14")).toBeUndefined();
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    const first = await h.t.admin("POST", trackedPath, {});
    expect(first.status).toBe(202);
    const failed = first.body.session.id;
    await until(() => store().sessions.require(failed).runtime === "failed");
    expect((await h.t.admin("GET", sessionWork(failed))).body).toBeNull();
    // Simulate the durable state left by a coordinator that exited before receiving the worktree result.
    const orphan = store().sessions.require(failed);
    store().putSession({ ...orphan, runtime: "starting" });
    requireService(h.t.c.ctx, "issueWork").recoverInterrupted();
    expect(store().sessions.require(failed).runtime).toBe("failed");
    expect(store().getIssueWork(h.project.id, "I_14")?.pendingSessionId).toBeNull();
    h.override = previous;
    const second = await h.t.admin("POST", repoOpen(14), { expectedNodeId: "I_14" });
    expect(second.status).toBe(202);
    expect(second.body.session.id).not.toBe(failed);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(1);
    await until(() => store().sessions.require(second.body.session.id).workspaceId !== null);
  });

  it("rejects paused, failed and lost memberships before mutation, but lets a stale row navigate known work", async () => {
    items = [item(15), item(16)];
    const scope = await create({ worktrees: false });
    const [first, second] = tracked(scope.id);
    expect((await patchSource(scope.id, { enabled: false })).status).toBe(200);
    const path = trackedOpen(first!.id);
    const paused = await h.t.admin("POST", path, {});
    expect(paused.body.error.message).toBe("Refresh the source before starting");
    expect(paused.status).toBe(409);
    await patchSource(scope.id, { enabled: true });
    const sourceRow = store().scopes.require(scope.id);
    store().putScope({ ...sourceRow, source: { ...sourceRow.source!, lastError: "sync failed" } });
    expect((await h.t.admin("POST", path, {})).status).toBe(409);
    store().putScope(sourceRow);
    items = [item(16)];
    expect((await h.t.admin("POST", path, {})).status).toBe(409);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
    expect(store().listIssueWork(h.project.id)).toEqual([]);
    const started = await h.t.admin("POST", trackedOpen(second!.id), {});
    expect(started.status).toBe(202);
    await patchSource(scope.id, { enabled: false });
    const reused = await h.t.admin("POST", trackedOpen(second!.id), { prompt: "never sent" });
    expect(reused.body).toMatchObject({ created: false, session: { id: started.body.session.id } });
  });

  it("requires a capable destination before github mutation, then separates read and work hosts", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(17)];
    const other = await secondHost({ defaultHost: true });
    try {
      const oldDestination = await h.t.admin("POST", repoOpen(17), { expectedNodeId: "I_17" });
      expect(oldDestination.body.error.code).toBe("unsupported_capability");
      expect(commandsOf(h.host, "tracker.repoIssue")).toHaveLength(1);
      expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
      expect(commandsOf(other, "workspace.create")).toHaveLength(0);
      expect(store().listIssueWork(h.project.id)).toEqual([]);
      await enableRepoIssues(other);
      // Force the capable non-default host for work, leaving the default as the GitHub reader.
      const result = await h.t.admin("POST", repoOpen(17), {
        expectedNodeId: "I_17",
        hostId: h.host.hostId,
      });
      expect(result.status, JSON.stringify(result.body.error)).toBe(202);
      expect(commandsOf(other, "tracker.startIssue")).toEqual([
        expect.objectContaining({ strict: true, checkoutPath: "/other/app" }),
      ]);
      expect(commandsOf(h.host, "tracker.prepareBranch")).toEqual([
        expect.objectContaining({ strict: true, branch: "17-issue-17" }),
      ]);
      expect(result.body.session.hostId).toBe(h.host.hostId);
      await until(() => store().sessions.require(result.body.session.id).workspaceId !== null);
    } finally {
      await other.close();
    }
  });

  it("rejects an unregistered discoverable collision without importing or starting it", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(18)];
    const previous = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "workspace.discover"
        ? [discovered(`${ROOT}/other`, "18-issue-18", "discovered")]
        : previous(cmd, id);
    expect((await h.t.admin("POST", repoOpen(18), { expectedNodeId: "I_18" })).status).toBe(409);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
    expect(
      store()
        .workspaces.list()
        .some((w) => w.branch === "18-issue-18"),
    ).toBe(false);
    expect(store().sessions.list()).toHaveLength(0);
  });

  it("persists a confirmed branch but refuses a failed strict preparation", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(19)];
    const previous = h.override!;
    h.override = (cmd, id) =>
      cmd.type === "tracker.prepareBranch"
        ? { __error: { code: "conflict", message: "divergent local branch" } }
        : previous(cmd, id);
    const result = await h.t.admin("POST", repoOpen(19), { expectedNodeId: "I_19" });
    expect(result.status).toBe(409);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    expect(store().sessions.list()).toHaveLength(0);
    expect(store().getIssueWork(h.project.id, "I_19")).toMatchObject({
      branch: "19-issue-19",
      remote: true,
      workspaceId: null,
    });
    // Generic branch work remains possible, but can't prove this issue's remote placement.
    const unrelated = await h.t.admin("POST", "/api/branches/open", {
      projectId: h.project.id,
      branch: "19-issue-19",
    });
    expect(unrelated.status).toBe(202);
    await until(() => store().sessions.require(unrelated.body.session.id).workspaceId !== null);
    expect((await h.t.admin("GET", sessionWork(unrelated.body.session.id))).body).toBeNull();
    expect((await h.t.admin("POST", repoOpen(19), { expectedNodeId: "I_19" })).status).toBe(409);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(1);
  });
});

describe("manual links", () => {
  const linkPath = (id: string) => `/api/issues/${encodeURIComponent(id)}/link`;
  async function worktree(branch: string) {
    const r = await h.t.admin("POST", "/api/workspaces", {
      checkoutId: h.project.checkouts[0]!.id,
      branch,
    });
    expect(r.status).toBe(201);
    return r.body as { id: string };
  }

  it("preserves an explicitly linked association after the scope is removed", async () => {
    items = [item(1)];
    const t = await create();
    const ws = await worktree("spike");
    const [issue] = tracked(t.id);
    expect((await h.t.admin("POST", linkPath(issue!.id), { workspaceId: ws.id })).status).toBe(200);
    expect((await h.t.admin("DELETE", `/api/scopes/${t.id}`)).status).toBe(200);
    expect(store().getIssueWork(issue!.projectId, issue!.itemId)).toMatchObject({
      branch: "spike",
      workspaceId: ws.id,
    });
  });

  it("links a worktree's branch to a not-started issue and keeps it across syncs", async () => {
    items = [item(1)];
    const t = await create();
    const ws = await worktree("spike");
    const [issue] = tracked(t.id);
    const r = await h.t.admin("POST", linkPath(issue!.id), { workspaceId: ws.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ branch: "spike", workspaceId: ws.id });
    const created = commandsOf(h.host, "workspace.create").length;
    await sync(t.id);
    expect(store().issues.require(issue!.id)).toMatchObject({
      branch: "spike",
      workspaceId: ws.id,
    });
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(created);
  });

  it("refuses a main checkout and an issue that has a branch", async () => {
    items = [item(1), item(2, { branches: ["feat/x"] })];
    const t = await create();
    const main = store()
      .workspaces.list("project_id = ?", [h.project.id])
      .find((w) => w.provenance === "main")!;
    const [first, second] = tracked(t.id);
    const r1 = await h.t.admin("POST", linkPath(first!.id), { workspaceId: main.id });
    expect(r1.status).toBe(409);
    const ws = await worktree("spike");
    const r2 = await h.t.admin("POST", linkPath(second!.id), { workspaceId: ws.id });
    expect(r2.status).toBe(409);
  });

  it("projects a manual link and unlink across boards without reviving a legacy link", async () => {
    items = [item(3)];
    const a = await create({ name: "A" });
    const b = await create({ name: "B" });
    const [first] = tracked(a.id);
    const [second] = tracked(b.id);
    const ws = await worktree("spike");
    expect((await h.t.admin("POST", linkPath(first!.id), { workspaceId: ws.id })).status).toBe(200);
    expect(store().issues.require(second!.id)).toMatchObject({
      branch: "spike",
      workspaceId: ws.id,
    });
    expect((await h.t.admin("DELETE", linkPath(second!.id))).status).toBe(200);
    expect(store().issues.require(first!.id)).toMatchObject({ branch: null, workspaceId: null });
    expect(store().getIssueWork(h.project.id, "I_3")).toBeUndefined();
  });

  it("overlays a GitHub link read-only, then reconciles the durable and tracked links on open", async () => {
    await enableRepoIssues();
    serveRepoIssues();
    items = [item(9)];
    const scope = await create({ worktrees: false });
    const [issue] = tracked(scope.id);
    const local = await worktree("local");
    expect((await h.t.admin("POST", linkPath(issue!.id), { workspaceId: local.id })).status).toBe(
      200,
    );
    // The board previously saw the old branch on GitHub, and that worktree still has a session.
    store().putIssue({ ...store().issues.require(issue!.id), branches: ["local"] });
    const old = await h.t.admin("POST", "/api/branches/open", {
      projectId: h.project.id,
      branch: "local",
    });
    expect(old.status).toBe(202);
    items = [item(9, { branches: ["remote", "ambiguous"] })];
    expect((await h.t.admin("POST", repoOpen(9), { expectedNodeId: "I_9" })).status).toBe(409);
    items = [item(9, { branches: ["remote"] })];
    const page = await h.t.admin("GET", repoIssues());
    expect(page.body.items[0]).toMatchObject({ branch: "remote", workspaceId: null });
    expect(store().getIssueWork(h.project.id, "I_9")).toMatchObject({
      branch: "local",
      workspaceId: local.id,
    });
    const opened = await h.t.admin("POST", repoOpen(9), { expectedNodeId: "I_9" });
    expect(opened.status, JSON.stringify(opened.body.error)).toBe(202);
    await until(() => store().sessions.require(opened.body.session.id).workspaceId !== null);
    const workspaceId = store().sessions.require(opened.body.session.id).workspaceId;
    expect(store().getIssueWork(h.project.id, "I_9")).toMatchObject({
      branch: "remote",
      workspaceId,
    });
    expect(store().issues.require(issue!.id)).toMatchObject({ branch: "remote", workspaceId });
    const reused = await h.t.admin("POST", trackedOpen(issue!.id), {});
    expect(reused.body).toMatchObject({ created: false, session: { id: opened.body.session.id } });
    expect(store().getIssueWork(h.project.id, "I_9")?.branch).toBe("remote");
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
  });

  it("unlinks a manual link, and refuses when GitHub links the branch", async () => {
    items = [item(1)];
    const t = await create();
    const ws = await worktree("spike");
    const [issue] = tracked(t.id);
    await h.t.admin("POST", linkPath(issue!.id), { workspaceId: ws.id });
    const r = await h.t.admin("DELETE", linkPath(issue!.id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ branch: null, workspaceId: null });
    await h.t.admin("POST", linkPath(issue!.id), { workspaceId: ws.id });
    items = [item(1, { branches: ["spike"] })];
    await sync(t.id);
    expect((await h.t.admin("DELETE", linkPath(issue!.id))).status).toBe(409);
  });
});

describe("work host", () => {
  it("makes the worktree on the project's default host, not the source's", async () => {
    const host2 = await secondHost({ defaultHost: true });
    items = [item(1, { branches: ["feat/y"] })];
    await create();
    expect(commandsOf(host2, "workspace.create")).toHaveLength(1);
    expect(commandsOf(h.host, "workspace.create")).toHaveLength(0);
    await host2.close();
  });
});

describe("retiring tracker tasks", () => {
  it("deletes untouched ones and detaches the rest, once", async () => {
    const base = (await h.t.admin("POST", "/api/tasks", { projectId: h.project.id, title: "a" }))
      .body as Task;
    const legacy = { trackerId: "trk_x", itemId: "I_1" };
    const untouched = { ...base, id: "tsk_untouched", tracker: legacy } as Task;
    const worked = { ...base, id: "tsk_worked", sessionId: "ses_1", tracker: legacy } as Task;
    store().tasks.upsert(untouched);
    store().tasks.upsert(worked);
    store().deleteSetting("trackerTasksRetired");
    service().start();
    service().stop();
    expect(store().tasks.get("tsk_untouched")).toBeUndefined();
    const kept = store().tasks.get("tsk_worked") as Task & { tracker?: unknown };
    expect(kept).toBeDefined();
    expect(kept.tracker).toBeUndefined();
    expect(store().getSetting("trackerTasksRetired", false)).toBe(true);
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
      allowUnassigned: false,
    });
    expect(tracked(t.id)[0]!.board!.status).toBe("In progress");
    // A person moves it back on GitHub: Switchyard does not fight them.
    await sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(1);
  });

  it("moves unassigned cards when following the board", async () => {
    items = [item(1, { branches: ["feat/x"], board: board("Todo") })];
    await create({ ...withBoard, follow: "board" });
    expect(commandsOf(h.host, "tracker.setStatus")[0]).toMatchObject({ allowUnassigned: true });
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
    await sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(2);
    moves = { status: "skipped", reason: "shared" };
    await sync(t.id);
    await sync(t.id);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(3);
  });

  it("does nothing without write-back", async () => {
    items = [item(1, { branches: ["feat/x"], board: board("Todo") })];
    await create({ board: withBoard.board });
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(0);
  });

  it("does not write back or open work for a delisted project", async () => {
    items = [item(1, { board: board("Todo") })];
    const scope = await create(withBoard);
    const issue = tracked(scope.id)[0]!;
    const project = store().projects.require(h.project.id);
    store().putProject({ ...project, catalog: { ...project.catalog, state: "delisted" } });
    expect((await h.t.admin("POST", trackedOpen(issue.id), {})).status).toBe(409);
    expect(
      (
        await h.t.admin("POST", `/api/issues/${encodeURIComponent(issue.id)}/status`, {
          status: "Review",
        })
      ).status,
    ).toBe(409);
    await sync(scope.id);
    expect(store().scopes.require(scope.id).projectIds).toEqual([]);
    expect(commandsOf(h.host, "tracker.setStatus")).toHaveLength(0);
    expect(commandsOf(h.host, "tracker.startIssue")).toHaveLength(0);
  });

  it("sets a column by hand and maps skips to conflicts", async () => {
    items = [item(1, { board: board("Todo") })];
    const t = await create(withBoard);
    const [issue] = tracked(t.id);
    const path = `/api/issues/${encodeURIComponent(issue!.id)}/status`;
    const ok = await h.t.admin("POST", path, { status: "review" });
    expect(ok.status).toBe(200);
    expect(ok.body.board.status).toBe("Review");
    expect((await h.t.admin("POST", path, { status: "Nope" })).status).toBe(400);
    moves = { status: "skipped", reason: "stale" };
    const stale = await h.t.admin("POST", path, { status: "Todo" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toBe("The card moved on GitHub; refresh and try again");
    await patchSource(t.id, { writeBack: false });
    expect((await h.t.admin("POST", path, { status: "Todo" })).status).toBe(403);
  });
});
