import { describe, expect, it } from "vitest";
import {
  branchInView,
  branchKeyOf,
  buildBranches,
  issueInView,
  primarySession,
  type Session,
  type TrackedIssue,
  trackerScope,
  type View,
  type Workspace,
} from "../src/index.js";

const T = "2026-11-01T00:00:00.000Z";
const at = (m: number) => new Date(Date.parse(T) + m * 60_000).toISOString();

function ws(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    checkoutId: "chk_1",
    projectId: "prj_a",
    hostId: "hst_1",
    path: `/r/${id}`,
    branch: "feat/x",
    baseBranch: "main",
    provenance: "managed",
    git: { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false },
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: T,
    ...over,
  };
}

function ses(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    subtitle: null,
    hostId: "hst_1",
    workspaceId: "wsp_1",
    projectId: "prj_a",
    cwd: "/r/wsp_1",
    nativeHandle: null,
    profileSnapshot: {} as Session["profileSnapshot"],
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: T,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: T,
    ...over,
  };
}

function issue(id: string, over: Partial<TrackedIssue> = {}): TrackedIssue {
  return {
    id,
    trackerId: "trk_1",
    itemId: id,
    projectId: "prj_a",
    repository: "acme/app",
    number: 1,
    title: "Issue",
    url: "https://github.com/acme/app/issues/1",
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    pullRequest: null,
    board: null,
    updatedAt: T,
    ...over,
  };
}

function view(over: Partial<View> = {}): View {
  return {
    id: "viw_1",
    name: "v",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    clients: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

const pr = (state: "OPEN" | "MERGED") => ({
  number: 3,
  state,
  url: "https://github.com/acme/app/pull/3",
  headRefName: "feat/x",
});

describe("primarySession", () => {
  it("prefers the chosen one, then the oldest live, then the most recent", () => {
    const a = ses("a", { createdAt: at(1), lastActivityAt: at(5) });
    const b = ses("b", { createdAt: at(2), lastActivityAt: at(9) });
    expect(primarySession([a, b])!.id).toBe("a");
    expect(primarySession([a, { ...b, primary: true }])!.id).toBe("b");
    const stopped = [
      { ...a, runtime: "stopped" as const },
      { ...b, runtime: "stopped" as const },
    ];
    expect(primarySession(stopped)!.id).toBe("b");
    expect(primarySession([])).toBeNull();
  });
});

describe("branchKeyOf", () => {
  it("keys branches, detached worktrees, folders and hosts", () => {
    const s = ses("a");
    expect(branchKeyOf(s, ws("wsp_1"))).toBe("b:prj_a:feat/x");
    expect(branchKeyOf(s, ws("wsp_1"), true)).toBe("b:prj_a:feat/x@hst_1");
    expect(branchKeyOf(s, ws("wsp_1", { branch: null }))).toBe("w:wsp_1");
    expect(branchKeyOf({ ...s, workspaceId: null, cwd: "/tmp" }, null)).toBe("d:hst_1:/tmp");
  });
});

describe("buildBranches", () => {
  it("merges the same branch on two hosts unless perHost", () => {
    const w1 = ws("wsp_1");
    const w2 = ws("wsp_2", { hostId: "hst_2" });
    const sessions = [
      ses("a", { lastActivityAt: at(1) }),
      ses("b", { workspaceId: "wsp_2", hostId: "hst_2", lastActivityAt: at(2) }),
    ];
    const { branches } = buildBranches({ workspaces: [w1, w2], sessions, issues: [] });
    expect(branches).toHaveLength(1);
    expect(branches[0]!.placements.map((p) => p.hostId)).toEqual(["hst_2", "hst_1"]);
    expect(branches[0]!.primary!.id).toBe("a");
    expect(branches[0]!.extras.map((s) => s.id)).toEqual(["b"]);
    const split = buildBranches({ workspaces: [w1, w2], sessions, issues: [] }, { perHost: true });
    expect(split.branches).toHaveLength(2);
  });

  it("nests subagents under their parent, or alone when the parent is gone", () => {
    const parent = ses("p");
    const sub = ses("s", { provenance: "subagent", parentSessionId: "p" });
    const orphan = ses("o", {
      provenance: "subagent",
      parentSessionId: "gone",
      workspaceId: null,
      cwd: "/tmp",
    });
    const { branches } = buildBranches({
      workspaces: [ws("wsp_1")],
      sessions: [parent, sub, orphan],
      issues: [],
    });
    const b = branches.find((x) => x.key === "b:prj_a:feat/x")!;
    expect(b.primary!.id).toBe("p");
    expect(b.subagents.map((s) => s.id)).toEqual(["s"]);
    const alone = branches.find((x) => x.kind === "scratch")!;
    expect(alone.primary).toBeNull();
    expect(alone.subagents.map((s) => s.id)).toEqual(["o"]);
  });

  it("keeps a branch with no session", () => {
    const { branches } = buildBranches({ workspaces: [ws("wsp_1")], sessions: [], issues: [] });
    expect(branches[0]).toMatchObject({ primary: null, stage: "working", main: false });
  });

  it("attaches issues by workspace or branch name and lists the rest as unstarted", () => {
    const byWs = issue("i1", { workspaceId: "wsp_1" });
    const byName = issue("i2", { branches: ["feat/y"] });
    const loose = issue("i3");
    const merged = issue("i4", { pullRequest: pr("MERGED") });
    const { branches, unstarted } = buildBranches({
      workspaces: [ws("wsp_1"), ws("wsp_2", { branch: "feat/y" })],
      sessions: [],
      issues: [byWs, byName, loose, merged],
    });
    expect(branches.find((b) => b.branch === "feat/x")!.issue!.id).toBe("i1");
    expect(branches.find((b) => b.branch === "feat/y")!.issue!.id).toBe("i2");
    expect(unstarted.map((i) => i.id)).toEqual(["i3"]);
  });

  it("derives the stage from the workspace's or the issue's pull request", () => {
    const withPr = ws("wsp_1", {
      github: {
        repository: "acme/app",
        headRepository: "acme/app",
        branch: "feat/x",
        fetchedAt: T,
        attemptedAt: T,
        status: "ready",
        reason: null,
        pullRequest: {
          number: 9,
          url: "https://github.com/acme/app/pull/9",
          title: "x",
          state: "OPEN",
          isDraft: false,
          headRefName: "feat/x",
          headRefOid: "a".repeat(40),
          headRepository: "acme/app",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          mergeQueueEnabled: false,
          inMergeQueue: false,
          autoMergeEnabled: false,
          squashMergeAllowed: true,
        },
        checks: [],
        checksComplete: true,
        threads: [],
        threadsComplete: true,
        truncated: false,
      } as unknown as Workspace["github"],
    });
    const a = buildBranches({ workspaces: [withPr], sessions: [], issues: [] });
    expect(a.branches[0]).toMatchObject({ stage: "in_review", pullRequest: { number: 9 } });
    const b = buildBranches({
      workspaces: [ws("wsp_1")],
      sessions: [],
      issues: [issue("i1", { workspaceId: "wsp_1", pullRequest: pr("MERGED") })],
    });
    expect(b.branches[0]!.stage).toBe("merged");
  });
});

describe("branchInView and issueInView", () => {
  const { branches } = buildBranches({
    workspaces: [ws("wsp_1")],
    sessions: [ses("a")],
    issues: [],
  });
  const b = branches[0]!;
  const lookup = { wsp_1: { projectId: "prj_a" } };

  it("follows pins in pinned mode", () => {
    expect(branchInView(view({ mode: "pinned" }), b, lookup)).toBe(false);
    expect(branchInView(view({ mode: "pinned", sessionIds: ["a"] }), b, lookup)).toBe(true);
    expect(issueInView(view({ mode: "pinned" }), issue("i"))).toBe(false);
  });

  it("filters by project and host", () => {
    expect(branchInView(view({ projectIds: ["prj_b"] }), b, lookup)).toBe(false);
    expect(branchInView(view({ hostIds: ["hst_2"] }), b, lookup)).toBe(false);
    const empty = buildBranches({ workspaces: [ws("wsp_1")], sessions: [], issues: [] })
      .branches[0]!;
    expect(branchInView(view({ projectIds: ["prj_a"], hostIds: ["hst_1"] }), empty, lookup)).toBe(
      true,
    );
    expect(issueInView(view({ projectIds: ["prj_a"] }), issue("i"))).toBe(true);
    expect(issueInView(view({ projectIds: ["prj_b"] }), issue("i"))).toBe(false);
  });

  it("a tracker view keeps issue branches and live sessions, not dormant leftovers or empty worktrees", () => {
    const v = view({ trackerId: "trk_1", projectIds: ["prj_a"] });
    const workspaces = [
      ws("wsp_1"),
      ws("wsp_2", { branch: "feat/live" }),
      ws("wsp_3", { branch: "feat/old" }),
      ws("wsp_4", { branch: "feat/empty" }),
    ];
    const sessions = [
      ses("a", { runtime: "stopped" }),
      ses("b", { workspaceId: "wsp_2", runtime: "running" }),
      ses("c", { workspaceId: "wsp_3", runtime: "stopped" }),
    ];
    const issues = [issue("i1", { workspaceId: "wsp_1" })];
    const { branches } = buildBranches({ workspaces, sessions, issues });
    const lookup = Object.fromEntries(workspaces.map((w) => [w.id, w]));
    const scope = trackerScope(v, issues);
    const kept = branches.filter((x) => branchInView(v, x, lookup, scope)).map((x) => x.branch);
    expect(kept.sort()).toEqual(["feat/live", "feat/x"]);
  });

  it("issueInView follows the tracker", () => {
    const v = view({ trackerId: "trk_1", projectIds: ["prj_b"] });
    expect(issueInView(v, issue("i"))).toBe(true);
    expect(issueInView(v, issue("i", { trackerId: "trk_2" }))).toBe(false);
  });
});
