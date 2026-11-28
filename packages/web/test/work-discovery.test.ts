import {
  type GitHubSource,
  issueBranchSet,
  type Project,
  RepoIssueItem,
  type Scope,
  sessionInScope,
  type TrackedIssue,
  trackedIssueId,
  type Workspace,
} from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { issueAction } from "../src/features/discovery/issueAction";
import {
  type DiscoveryInput,
  discoveryContext,
  discoveryProjects,
  type IssueInventoryOptions,
  inventoryIntent,
  issueInventory,
  repositoryInventory,
  scopeRepositoryLabel,
} from "../src/features/discovery/model";
import { describeDiscoverySource } from "../src/features/scopes/describe";
import { currentScopeId } from "../src/features/scopes/selection";
import { usePrefs } from "../src/prefs";
import { useSyncStore } from "../src/sync/store";
import { session } from "./fixtures";

const NOW = "2026-11-02T10:00:00.000Z";
const alpha = { id: "a", name: "Alpha", repoIdentity: "https://github.com/acme/alpha" };
const beta = { id: "b", name: "Beta", repoIdentity: "https://github.com/acme/beta" };
const local = { id: "c", name: "Local", repoIdentity: "local:/repo" };
const project = (id: string): Pick<Project, "id" | "name" | "repoIdentity"> => ({ ...alpha, id });

function scope(patch: Partial<Scope> = {}): Scope {
  return {
    id: "manual",
    name: "Work",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    source: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

it("treats a retired saved scope as All work once synced", () => {
  const { hydrated, scopes } = useSyncStore.getState();
  const { filters } = usePrefs.getState();
  try {
    usePrefs.getState().setFilter("codeView", "retired");
    useSyncStore.setState({ hydrated: false, scopes: {} });
    expect(currentScopeId()).toBe("retired");
    useSyncStore.setState({ hydrated: true, scopes: { retired: scope({ id: "retired" }) } });
    expect(currentScopeId()).toBe("retired");
    useSyncStore.setState({ scopes: {} });
    expect(currentScopeId()).toBeNull();
  } finally {
    useSyncStore.setState({ hydrated, scopes });
    usePrefs.setState({ filters });
  }
});

const sourceBoard = {
  projectNumber: 4,
  statusField: "Status",
  onStart: "Working",
  onReview: "Review",
  backlog: ["Someday", "Backlog"],
};

function sourced(id = "team", patch: Partial<GitHubSource> = {}, cover = [alpha.id]): Scope {
  return scope({
    id,
    name: id === "team" ? "Team board" : "My issues",
    projectIds: cover,
    source: {
      kind: "github",
      hostId: "sync-host",
      owner: "acme",
      repositories: null,
      board: sourceBoard,
      writeBack: true,
      moveShared: false,
      enabled: true,
      login: "me",
      lastSyncedAt: NOW,
      lastError: null,
      ...patch,
    },
  });
}

const board: NonNullable<TrackedIssue["board"]> = {
  projectId: "p",
  projectItemId: "card",
  fieldId: "field",
  status: "To Do",
  statusOptionId: "todo",
  options: [
    { id: "todo", name: "To Do" },
    { id: "working", name: "Working" },
    { id: "review", name: "Review" },
  ],
};

function issue(itemId: string, patch: Partial<TrackedIssue> = {}): TrackedIssue {
  const scopeId = patch.scopeId ?? "team";
  const repository = patch.repository ?? "acme/alpha";
  const number = patch.number ?? 9;
  return {
    id: trackedIssueId(scopeId, itemId),
    itemId,
    scopeId,
    projectId: alpha.id,
    repository,
    number,
    title: `Issue ${itemId}`,
    url: `https://github.com/${repository}/issues/${number}`,
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    pullRequest: null,
    board: null,
    updatedAt: NOW,
    ...patch,
  };
}

function workspace(id: string, branch: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    branch,
    hostId: "work-host",
    checkoutId: "checkout",
    projectId: alpha.id,
    path: `/repo/.worktrees/${id}`,
    baseBranch: "main",
    provenance: "managed",
    git: { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false },
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: NOW,
    ...patch,
  };
}

function pullRequest(state: "OPEN" | "MERGED") {
  return { state, number: 1, url: "https://github.com/acme/alpha/pull/1", headRefName: "one" };
}

const byId = <T extends { id: string }>(records: T[]): Record<string, T> =>
  Object.fromEntries(records.map((record) => [record.id, record]));
const input = (issues: TrackedIssue[], patch: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  projects: byId([alpha, beta, local]),
  issues: byId(issues),
  scopes: byId([sourced(), sourced("mine")]),
  workspaces: {},
  sessions: {},
  ...patch,
});
const opts = (patch: Partial<IssueInventoryOptions> = {}): IssueInventoryOptions => ({
  scope: null,
  projectId: null,
  query: "",
  subset: "all",
  sort: "number",
  ...patch,
});

const ids = (data: DiscoveryInput, options = opts()) =>
  issueInventory(data, options).map((i) => i.id);

describe("discovery coverage", () => {
  it("distinguishes unrestricted, empty, fixed and partially resolved coverage", () => {
    const projects = [alpha];
    expect(discoveryContext(null, projects)).toEqual({
      coverage: "all",
      projectIds: null,
      fixedProjectId: null,
    });
    expect(discoveryContext(scope(), projects)).toEqual(discoveryContext(null, projects));
    expect(discoveryContext(scope({ projectIds: [] }), projects)).toEqual({
      coverage: "projects",
      projectIds: [],
      fixedProjectId: null,
    });
    expect(discoveryContext(scope({ projectIds: [alpha.id] }), projects).fixedProjectId).toBe(
      alpha.id,
    );
    expect(discoveryContext(sourced(), projects).fixedProjectId).toBe(alpha.id);
    expect(
      discoveryContext(scope({ projectIds: ["missing"] }), projects).fixedProjectId,
    ).toBeNull();
    expect(discoveryContext(scope({ projectIds: [alpha.id, "missing"] }), projects)).toEqual({
      coverage: "projects",
      projectIds: [alpha.id, "missing"],
      fixedProjectId: null,
    });
    expect(discoveryContext(scope({ mode: "pinned", projectIds: [alpha.id] }), projects)).toEqual({
      coverage: "pins",
      projectIds: [],
      fixedProjectId: null,
    });
  });

  it("keeps the covered repository choices even if only one has results", () => {
    const multi = scope({ projectIds: [beta.id, alpha.id] });
    const data = input([issue("one")]);
    expect(ids(data, opts({ scope: multi }))).toHaveLength(1);
    expect(discoveryContext(multi, [alpha, beta]).fixedProjectId).toBeNull();
    expect(discoveryProjects(multi, [local, beta, alpha])).toEqual([alpha, beta]);
    expect(discoveryProjects(null, [beta, alpha])).toEqual([alpha, beta]);
    expect(discoveryProjects(scope({ mode: "pinned" }), [alpha])).toEqual([]);
    expect(discoveryProjects(null, [alpha, project("0")]).map((p) => p.id)).toEqual(["0", "a"]);
  });

  it("chooses repository inventory only for a concrete GitHub project outside contextual source membership", () => {
    const projects = byId([alpha, beta, local]);
    const contextual = { kind: "contextual" } as const;
    const explicit = { kind: "repository", projectId: alpha.id } as const;
    expect(inventoryIntent(null, contextual, null, projects).coverage).toBe("known");
    expect(inventoryIntent(null, contextual, alpha.id, projects).kind).toBe("repository");
    expect(inventoryIntent(null, contextual, local.id, projects).kind).toBe("tracked");
    const manual = scope({ projectIds: [alpha.id] });
    expect(inventoryIntent(manual, contextual, null, projects).kind).toBe("repository");
    const multi = scope({ projectIds: [alpha.id, beta.id] });
    expect(inventoryIntent(multi, contextual, null, projects).coverage).toBe("known");
    expect(inventoryIntent(multi, contextual, beta.id, projects).kind).toBe("repository");
    expect(inventoryIntent(sourced(), contextual, null, projects).coverage).toBe("source");
    expect(
      inventoryIntent(sourced("mine", {}, [alpha.id, beta.id]), contextual, beta.id, projects)
        .coverage,
    ).toBe("source");
    const pins = scope({ mode: "pinned" });
    expect(inventoryIntent(pins, contextual, alpha.id, projects).kind).toBe("pins");
    expect(inventoryIntent(sourced(), explicit, null, projects).kind).toBe("repository");
    expect(inventoryIntent(pins, explicit, null, projects).kind).toBe("repository");
    expect(
      inventoryIntent(sourced(), { kind: "repository", projectId: "removed" }, null, projects),
    ).toMatchObject({ kind: "repository", project: null });
  });

  it("names the fixed scope and repository only once", () => {
    expect(scopeRepositoryLabel(scope({ name: "ALPHA" }), alpha)).toBe("ALPHA");
    expect(scopeRepositoryLabel(scope({ name: "ALPHA" }), alpha, true)).toBeNull();
    expect(scopeRepositoryLabel(scope(), alpha)).toBe("Work · Alpha");
    expect(scopeRepositoryLabel(scope(), alpha, true)).toBe("Alpha");
  });
});

describe("shared tracked issue inventory", () => {
  it("applies issue scope membership and explicit repository refinement separately from session pins", () => {
    const a = issue("one");
    const sibling = issue("one", { scopeId: "mine" });
    const b = issue("beta", { projectId: beta.id, repository: "acme/beta" });
    const pinned = session("pinned", { projectId: beta.id, runtime: "stopped" });
    const data = input([a, sibling, b], { sessions: byId([pinned]) });
    const team = { ...sourced(), sessionIds: [pinned.id] };
    const projectScope = scope({
      projectIds: [alpha.id],
      hostIds: ["other-host"],
      sessionIds: [pinned.id],
    });
    const pins = scope({ mode: "pinned", sessionIds: [pinned.id] });
    expect(ids(data, opts({ scope: team }))).toEqual([a.id, b.id]);
    expect(ids(data, opts({ scope: projectScope }))).toEqual([sibling.id, a.id]);
    expect(ids(data, opts({ scope: scope({ projectIds: [] }) }))).toEqual([]);
    expect(ids(data, opts({ scope: projectScope, projectId: beta.id }))).toEqual([]);
    expect(ids(data, opts({ scope: pins, subset: "notStarted" }))).toEqual([]);
    for (const selected of [team, projectScope, pins]) {
      const set = issueBranchSet(selected, Object.values(data.issues));
      expect(sessionInScope(selected, pinned, data.workspaces, set)).toBe(true);
    }
    // Only a deliberate local escape omits scope from the inventory; pins themselves stay unchanged.
    expect(ids(data, opts({ scope: null, projectId: beta.id }))).toEqual([b.id]);
    expect(pins).toMatchObject({ id: "manual", mode: "pinned", sessionIds: [pinned.id] });
    expect(ids(data, opts({ scope: pins }))).toEqual([]);
  });

  it("sorts by repository and number by default, with source priority only on request", () => {
    const high = issue("high", {
      number: 20,
      board: { ...board, priority: { name: "Urgent", rank: 0 } },
    });
    const duplicateA = issue("tie", { number: 2 });
    const duplicateB = issue("tie", { number: 2, scopeId: "mine", repository: "acme/alpha" });
    const otherRepo = issue("other", { number: 2, projectId: beta.id, repository: "acme/beta" });
    const data = input([high, otherRepo, duplicateA, duplicateB]);
    expect(ids(data)).toEqual([duplicateB.id, duplicateA.id, high.id, otherRepo.id]);
    expect(ids(data, opts({ sort: "priority" }))).toEqual([
      high.id,
      duplicateB.id,
      duplicateA.id,
      otherRepo.id,
    ]);
    expect(issueInventory(data, opts()).map((item) => [item.origin, item.showOrigin])).toEqual([
      ["My issues", true],
      ["Team board", true],
      ["Team board", false],
      ["Team board", false],
    ]);
    expect(Object.keys(data.issues)).toEqual([high.id, otherRepo.id, duplicateA.id, duplicateB.id]);
  });

  it("matches issue facts case-insensitively, including bare and prefixed numbers", () => {
    const match = issue("a", {
      number: 7,
      title: "Fix drop-down",
      assignees: ["Megan"],
      board: { ...board, priority: { rank: 2, name: "Soon" } },
    });
    const data = input([match, issue("other", { projectId: beta.id, repository: "acme/beta" })]);
    for (const query of [
      " Fix DROP ",
      "#7",
      "7",
      "007",
      "ACME/AL",
      "aLPhA",
      "TO DO",
      "SOON",
      "mEgAn",
    ])
      expect(ids(data, opts({ query })), query).toEqual([match.id]);
    expect(ids(data, opts({ query: "missing" }))).toEqual([]);
  });

  it("keeps the same ordered issue menu with or without Board-only input fields", () => {
    const data = input([
      issue("third", { number: 3 }),
      issue("second", { number: 2 }),
      issue("started", { number: 1, branch: "remote" }),
      issue("other", { projectId: beta.id }),
    ]);
    const options = opts({
      scope: sourced(),
      projectId: alpha.id,
      query: "ISSUE",
      subset: "notStarted",
    });
    const boardInput = { ...data, hosts: {}, attention: {}, interactions: {} };
    const launcherInput = {
      projects: data.projects,
      issues: data.issues,
      workspaces: {},
      sessions: {},
    };
    expect(ids(boardInput, options)).toEqual(["team:second", "team:third"]);
    expect(ids(launcherInput, options)).toEqual(ids(boardInput, options));
  });

  it("resolves own workspace, chosen branch and first placed linked branch without losing siblings", () => {
    const chosen = workspace("chosen", "chosen");
    const own = workspace("own", "own");
    const linked = workspace("linked", "linked");
    const linkedOnOtherHost = workspace("linked-on-mac", "linked", { hostId: "mac" });
    const archived = workspace("archived", "gone", { archivedAt: NOW });
    const mine = issue("own", { workspaceId: own.id, branch: "chosen", branches: ["linked"] });
    const pickChosen = issue("chosen", {
      workspaceId: archived.id,
      branch: "chosen",
      branches: ["linked"],
    });
    const fallback = issue("fallback", {
      branch: "not here",
      branches: ["also not here", "linked", "chosen"],
      pullRequest: pullRequest("MERGED"),
    });
    const sibling = issue("sibling", {
      scopeId: "mine",
      branches: ["linked"],
      workspaceId: linked.id,
    });
    const remote = issue("remote", { branches: ["gone", "unplaced"] });
    const primary = session("primary", {
      workspaceId: linkedOnOtherHost.id,
      hostId: "mac",
      runtime: "stopped",
      connectivity: "disconnected",
      primary: true,
    });
    const data = input(
      [mine, pickChosen, fallback, sibling, remote, issue("unstarted", { board })],
      {
        workspaces: byId([chosen, own, linked, linkedOnOtherHost, archived]),
        sessions: byId([
          primary,
          session("active", { workspaceId: linked.id, runtime: "running" }),
        ]),
      },
    );
    const found = byId(issueInventory(data, opts()));
    expect(found[mine.id]).toMatchObject({
      branchName: "own",
      placement: { workspace: { id: own.id } },
    });
    expect(found[pickChosen.id]).toMatchObject({
      branchName: "chosen",
      placement: { workspace: { id: chosen.id } },
    });
    expect(found[fallback.id]).toMatchObject({
      branchName: "linked",
      placement: { hostId: "mac" },
      sessionId: primary.id,
      merged: true,
    });
    expect(found[sibling.id]).toMatchObject({
      branchName: "linked",
      placement: { workspace: { id: linked.id } },
      sessionId: primary.id,
      merged: false,
    });
    expect(found[remote.id]).toMatchObject({
      branch: null,
      branchName: "gone",
      placement: null,
      notStarted: false,
      stage: "working",
    });
    expect(ids(data, opts({ subset: "notStarted" }))).toEqual(["team:unstarted"]);
  });
});

describe("repository issue inventory", () => {
  it("keeps one repository row by node and project while every source retains its own membership", () => {
    const team = issue("shared", { board });
    const mine = issue("shared", { scopeId: "mine" });
    const other = issue("shared", { projectId: beta.id, scopeId: "elsewhere" });
    const repoItem = RepoIssueItem.parse({ ...team, board: null, sessionId: "pending" });
    const data = input([team, mine, other]);
    const repo = repositoryInventory(data, opts(), [repoItem, repoItem]);
    expect(repo).toHaveLength(1);
    expect(repo[0]).toMatchObject({
      issue: { board: null },
      origin: "Repository issues",
      showOrigin: false,
      sessionId: "pending",
      notStarted: false,
      locator: { kind: "repository", projectId: alpha.id, number: 9, nodeId: "shared" },
    });
    expect(
      issueInventory(data, opts(), [repoItem]).map((r) => [r.id, r.sessionId, r.showOrigin]),
    ).toEqual([
      ["elsewhere:shared", null, false],
      ["mine:shared", "pending", true],
      ["team:shared", "pending", true],
    ]);
    expect(issueInventory(data, opts({ scope: sourced() }), [repoItem])[0]?.locator).toEqual({
      kind: "tracked",
      id: team.id,
    });
    expect(repositoryInventory(data, opts({ subset: "notStarted" }), [repoItem])).toEqual([]);
  });

  it("does not guess which remote link to open if the repository has no effective branch", () => {
    const ws = workspace("w", "maybe");
    const data = input([], {
      workspaces: byId([ws]),
      sessions: byId([session("s", { workspaceId: ws.id })]),
    });
    const ambiguous = RepoIssueItem.parse({
      ...issue("ambiguous", { branches: ["maybe", "another"] }),
      sessionId: null,
    });
    expect(repositoryInventory(data, opts(), [ambiguous])[0]).toMatchObject({
      sessionId: null,
      branchName: null,
      notStarted: false,
    });
  });

  it("advertises a GitHub branch link, never source write-back", () => {
    const row = RepoIssueItem.parse({ ...issue("open"), sessionId: null });
    const item = repositoryInventory(input([]), opts(), [row])[0]!;
    expect(issueAction(item, { scopes: byId([sourced()]) })).toMatchObject({
      kind: "start",
      locator: { kind: "repository", projectId: alpha.id, number: 9, nodeId: "open" },
      request: {},
      consequences: [
        "Create branch and worktree",
        "Link branch on GitHub",
        "Use project placement",
      ],
    });
  });
});

describe("discovery descriptions", () => {
  it("lists matching sources by name, describes their coverage and keeps paused/error facts", () => {
    const team = sourced("team", {
      follow: "board",
      enabled: false,
      lastError: "Host unavailable",
    });
    const mine = sourced("mine", { board: null }, [alpha.id, beta.id]);
    const scopes = byId([mine, team]);
    const singleRepo = describeDiscoverySource(scope(), alpha, scopes);
    expect(singleRepo.summary).toBe("Tracked by My issues, Team board");
    expect(singleRepo.sources).toEqual([
      {
        id: mine.id,
        name: mine.name,
        description: "Assigned to me",
        paused: false,
        lastSyncedAt: NOW,
        lastError: null,
      },
      {
        id: team.id,
        name: team.name,
        description: "Board #4 · excludes Someday, Backlog until work starts · Sync paused",
        paused: true,
        lastSyncedAt: NOW,
        lastError: "Host unavailable",
      },
    ]);
    expect(describeDiscoverySource(scope({ projectIds: [beta.id] }), null, scopes).summary).toBe(
      "Tracked by My issues",
    );
    expect(describeDiscoverySource(team, null, scopes).summary).toBe("Tracked by Team board");
    expect(describeDiscoverySource(team, beta, scopes).sources).toEqual([]);
  });

  it("distinguishes filtered, empty, unconnected and pins-only states", () => {
    const sources = [sourced()];
    const connected = describeDiscoverySource(null, alpha, sources);
    expect(connected.emptyState(true).title).toBe("No matches");
    expect(connected.emptyState(false).title).toBe("No tracked issues here");
    expect(describeDiscoverySource(null, beta, sources).emptyState(false)).toMatchObject({
      title: "No issue source connected",
      action: { to: "/settings/scopes" },
    });
    expect(
      describeDiscoverySource(scope({ mode: "pinned" }), null, sources).emptyState(true).title,
    ).toBe("This scope contains pinned sessions only");
  });

  it("links to all open issues only for a concrete, canonical GitHub repository", () => {
    expect(describeDiscoverySource(null, alpha, []).openIssuesUrl).toBe(
      "https://github.com/acme/alpha/issues",
    );
    expect(describeDiscoverySource(null, null, [sourced()]).openIssuesUrl).toBeNull();
    expect(describeDiscoverySource(scope({ mode: "pinned" }), alpha, []).openIssuesUrl).toBeNull();
    for (const repoIdentity of [
      local.repoIdentity,
      "https://github.com.evil/acme/alpha",
      "https://github.com/acme/alpha?key=value",
      "https://github.com/acme/alpha#fragment",
      "https://github.com/acme/alpha/extra",
      "https://github.com/acme/..",
      "https://github.com/acme/%2E%2E",
      "https://git@github.com/acme/alpha",
      "http://github.com/acme/alpha",
    ]) {
      expect(
        describeDiscoverySource(null, { ...alpha, repoIdentity }, []).openIssuesUrl,
        repoIdentity,
      ).toBeNull();
    }
  });
});

describe("issue action intent", () => {
  const getItem = (issue: TrackedIssue, patch?: Partial<DiscoveryInput>) =>
    issueInventory(input([issue], patch), opts())[0]!;

  it("opens a known primary directly even if stopped, offline or merged", () => {
    const worktree = workspace("w", "done");
    const merged = issue("done", { branch: "done", pullRequest: pullRequest("MERGED") });
    const stopped = session("stopped", {
      workspaceId: worktree.id,
      hostId: worktree.hostId,
      runtime: "stopped",
      connectivity: "disconnected",
    });
    const item = getItem(merged, { workspaces: byId([worktree]), sessions: byId([stopped]) });
    expect(
      issueAction(item, { hostId: "another", profileId: "different", instruction: "Keep this" }),
    ).toEqual({
      kind: "open",
      label: "Open session",
      sessionId: stopped.id,
      consequences: ["Your instruction stays a draft; opening does not send it."],
    });
    expect(issueAction(getItem(merged))).toEqual({
      kind: "none",
      label: "Merged",
      consequences: [],
    });
    expect(issueInventory(input([merged]), opts({ subset: "notStarted" }))).toEqual([]);
  });

  it("prepares a listed project's checkout on the requested host before issue work", () => {
    const item = getItem(issue("a"));
    const projects = { [item.projectId]: { catalog: { state: "listed" as const } } };
    const checkouts = { local: { projectId: item.projectId, hostId: "local" } };
    expect(issueAction(item, { projects, checkouts: {} })).toMatchObject({
      kind: "prepare",
      locator: item.locator,
    });
    expect(issueAction(item, { projects, checkouts }).kind).toBe("start");
    expect(issueAction(item, { projects, checkouts, hostId: "remote" }).kind).toBe("prepare");
    expect(
      issueAction(item, {
        projects: { [item.projectId]: { catalog: { state: "delisted" } } },
        checkouts,
      }),
    ).toMatchObject({ kind: "none" });
  });

  it("uses only the user's instruction, never a fake issue prompt or a scope pin", () => {
    const item = getItem(issue("a"));
    expect(issueAction(item, { instruction: "   " })).toEqual({
      kind: "start",
      label: "Start session",
      locator: { kind: "tracked", id: item.id },
      request: {},
      consequences: ["Create branch and worktree", "Local branch only", "Use project placement"],
    });
    const action = issueAction(item, {
      instruction: "  Try writing a regression test.\n",
      hostId: "work-host",
      hosts: { "work-host": { name: "Mac" } },
      profileId: "focused",
      scopes: byId([sourced()]),
      checkouts: {
        work: { hostId: "work-host", projectId: alpha.id },
        source: { hostId: "sync-host", projectId: alpha.id },
      },
    });
    expect(action).toMatchObject({
      kind: "start",
      label: "Start and send",
      request: {
        hostId: "work-host",
        profileId: "focused",
        prompt: "  Try writing a regression test.\n",
      },
    });
    expect(action.consequences).toEqual([
      "Create branch and worktree",
      "Link branch on GitHub",
      "On Mac",
      "If a session already exists, your instruction stays a draft instead of being sent.",
    ]);
    expect(action.kind === "start" && Object.keys(action.request)).toEqual([
      "hostId",
      "profileId",
      "prompt",
    ]);
    const wrongCheckout = issueAction(item, {
      scopes: byId([sourced()]),
      checkouts: { wrong: { hostId: "sync-host", projectId: beta.id } },
    });
    expect(wrongCheckout.consequences).toContain("Local branch only");
  });

  it("distinguishes known worktrees from unplaced branches or explicit placements elsewhere", () => {
    const linked = issue("a", { branch: "my-branch" });
    const worktree = workspace("w", "my-branch");
    const placed = getItem(linked, { workspaces: byId([worktree]) });
    expect(issueAction(placed).consequences).toEqual([
      "Use my-branch",
      "Use existing worktree",
      "Use project placement",
    ]);
    expect(
      issueAction(placed, { hostId: "mac", hosts: { mac: { name: "Mac" } } }).consequences,
    ).toEqual(["Use my-branch", "Create worktree", "On Mac"]);
    expect(issueAction(getItem(linked)).consequences).toEqual([
      "Use my-branch",
      "Create worktree",
      "Use project placement",
    ]);
  });

  it("does not allow a new start from paused, failed or never-synced sources", () => {
    const row = getItem(issue("stale"));
    for (const patch of [
      { enabled: false },
      { lastError: "Host unavailable" },
      { lastSyncedAt: null },
    ]) {
      const source = sourced("team", patch);
      expect(issueAction(row, { scopes: byId([source]) })).toMatchObject({
        kind: "none",
        label: "Refresh the source before starting",
      });
      expect(describeDiscoverySource(source, alpha, [source]).emptyState(false).title).toBe(
        "No current issue results",
      );
    }
  });

  it("describes only applicable conditional write-back from the issue's own source", () => {
    const item = getItem(issue("a", { board, assignees: ["ME"] }));
    const hints = (scope: Scope, selected = item) =>
      issueAction(selected, { scopes: byId([scope]) }).consequences.filter((line) =>
        line.startsWith("On sync"),
      );
    expect(hints(sourced())).toEqual(["On sync, may move to Working"]);
    expect(hints(sourced("mine"))).toEqual([]);
    expect(hints(sourced("team", { writeBack: false }))).toEqual([]);
    expect(hints(sourced("team", { enabled: false }))).toEqual([]);
    expect(hints(sourced("team", { board: { ...sourceBoard, onStart: "Not a column" } }))).toEqual(
      [],
    );
    expect(hints(sourced(), getItem(issue("b", { board, assignees: ["me", "you"] })))).toEqual([]);
    expect(hints(sourced(), getItem(issue("b", { board, assignees: ["you"] })))).toEqual([]);
    expect(
      hints(
        sourced(),
        getItem(
          issue("b", {
            board: { ...board, status: "Working", statusOptionId: "working" },
            assignees: ["me"],
          }),
        ),
      ),
    ).toEqual([]);
    expect(hints(sourced("team", { follow: "board" }), getItem(issue("b", { board })))).toEqual([
      "On sync, may move to Working",
    ]);
    expect(
      hints(
        sourced(),
        getItem(
          issue("b", {
            board,
            branch: "reviewing",
            pullRequest: pullRequest("OPEN"),
            assignees: ["me"],
          }),
        ),
      ),
    ).toEqual(["On sync, may move to Review"]);
  });
});
