import type {
  GitHubScope,
  GitHubSource,
  Host,
  Project,
  Scope,
  Session,
  TrackedIssue,
  Workspace,
} from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardInput,
  boardMode,
  buildBoard,
  buildBoardWithEmpty,
  canDrop,
  githubBoardOf,
} from "../src/features/workboard/model";
import { session } from "./fixtures";

const T0 = "2026-11-01T10:00:00.000Z";

const project = (id: string): Project =>
  ({ id, name: `Project ${id}`, repoIdentity: `https://github.com/acme/${id}` }) as Project;
const host = (id: string): Host => ({ id, name: `Host ${id}` }) as Host;

function ws(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    checkoutId: "chk_1",
    projectId: "prj_1",
    hostId: "hst_1",
    path: `/repo/.worktrees/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    provenance: "managed",
    git: { dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false },
    setup: { state: "none", log: "" },
    archivedAt: null,
    updatedAt: T0,
    ...patch,
  };
}

const board = (status: string | null) => ({
  projectId: "P",
  projectItemId: "PI",
  fieldId: "F",
  status,
  statusOptionId: status ? `o-${status}` : null,
  options: [
    { id: "o-Todo", name: "Todo" },
    { id: "o-Doing", name: "Doing" },
  ],
});

function issue(id: string, patch: Partial<TrackedIssue> = {}): TrackedIssue {
  return {
    id,
    scopeId: "trk_1",
    itemId: id,
    projectId: "prj_1",
    repository: "acme/prj_1",
    number: 7,
    title: `Issue ${id}`,
    url: "https://github.com/acme/prj_1/issues/7",
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    pullRequest: null,
    board: null,
    updatedAt: T0,
    ...patch,
  };
}

const pr = (state: "OPEN" | "MERGED") => ({
  number: 3,
  state,
  url: "https://github.com/acme/prj_1/pull/3",
  headRefName: "x",
});

function input(patch: Partial<BoardInput> = {}): BoardInput {
  return {
    projects: { prj_1: project("prj_1"), prj_2: project("prj_2") },
    workspaces: {
      wm: ws("wm", { provenance: "main", branch: "main" }),
      w1: ws("w1"),
      w2: ws("w2"),
      w3: ws("w3"),
    },
    sessions: {
      a: session("a", { workspaceId: "w1", runtime: "running" }),
    } as Record<string, Session>,
    hosts: { hst_1: host("hst_1") },
    attention: {},
    interactions: {},
    issues: {
      i0: issue("i0"),
      i2: issue("i2", { workspaceId: "w2", pullRequest: pr("OPEN") }),
      i3: issue("i3", { workspaceId: "w3", pullRequest: pr("MERGED") }),
    },
    ...patch,
  };
}

const scope = (over: Partial<Scope> = {}): Scope =>
  ({
    id: "viw_1",
    name: "v",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    source: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }) as Scope;

/** A GitHub scope with the id its issues carry. */
const github = (over: Partial<GitHubSource> = {}): GitHubScope =>
  scope({
    id: "trk_1",
    name: "personal",
    source: {
      kind: "github",
      owner: "acme",
      board: { projectNumber: 4, statusField: "Status", onStart: null, onReview: null },
      writeBack: true,
      ...over,
    } as GitHubSource,
  }) as GitHubScope;

const keys = (cols: ReturnType<typeof buildBoard>) =>
  Object.fromEntries(cols.map((c) => [c.id, c.cards.map((x) => x.key)]));

describe("work board", () => {
  it("leaves out worktrees with no session, issue or pull request when asked", () => {
    const data = input({ workspaces: { ...input().workspaces, w9: ws("w9") } });
    const opts = { scope: null, query: "", mode: "stage" as const, github: null };
    const shown = buildBoardWithEmpty(data, opts);
    expect(shown.empty).toBe(1);
    expect(shown.columns.flatMap((c) => c.cards).some((c) => c.key.endsWith("feat/w9"))).toBe(true);
    const hidden = buildBoardWithEmpty(data, { ...opts, showEmpty: false });
    expect(hidden.empty).toBe(1);
    const cards = hidden.columns.flatMap((c) => c.cards);
    expect(cards.some((c) => c.key.endsWith("feat/w9"))).toBe(false);
    // Worktrees with a session, an issue or a pull request stay.
    expect(cards.length).toBe(shown.columns.flatMap((c) => c.cards).length - 1);
  });

  it("puts branches and issues in stage columns from facts", () => {
    const cols = buildBoard(input(), { scope: null, query: "", mode: "stage", github: null });
    expect(cols.map((c) => c.label)).toEqual(["Not started", "Working", "In review", "Merged"]);
    expect(keys(cols)).toEqual({
      not_started: ["i:i0"],
      working: ["b:prj_1:feat/w1"],
      in_review: ["b:prj_1:feat/w2"],
      merged: ["b:prj_1:feat/w3"],
    });
    expect(cols[2]!.cards[0]).toMatchObject({ key: "b:prj_1:feat/w2", sessionId: null });
    const w1 = cols[1]!.cards[0]!;
    expect(w1).toMatchObject({ sessionId: "a", branchLabel: "feat/w1", host: null });
  });

  it("shows a main checkout only when it has a session", () => {
    const cols = buildBoard(
      input({
        sessions: { m: session("m", { workspaceId: "wm" }) } as Record<string, Session>,
      }),
      { scope: null, query: "", mode: "stage", github: null },
    );
    const main = cols[1]!.cards.find((c) => c.key === "b:prj_1:main")!;
    expect(main.branchLabel).toBeNull();
    const without = buildBoard(input({ sessions: {} }), {
      scope: null,
      query: "",
      mode: "stage",
      github: null,
    });
    expect(without[1]!.cards.some((c) => c.key === "b:prj_1:main")).toBe(false);
  });

  it("filters branches and issues by the scope and the search", () => {
    const other = buildBoard(input(), {
      scope: scope({ projectIds: ["prj_2"] }),
      query: "",
      mode: "stage",
      github: null,
    });
    expect(other.every((c) => c.cards.length === 0)).toBe(true);
    const found = buildBoard(input(), { scope: null, query: "#7", mode: "stage", github: null });
    expect(found[0]!.cards).toHaveLength(1);
  });

  it("a GitHub scope shows its issues, their branches and live sessions only", () => {
    const tv = { ...github(), projectIds: ["prj_1"] };
    const data = input({
      sessions: {
        a: session("a", { workspaceId: "w1", runtime: "running" }),
        s: session("s", { workspaceId: "w3", runtime: "stopped" }),
      } as Record<string, Session>,
      issues: {
        i0: issue("i0"),
        i2: issue("i2", { workspaceId: "w2" }),
        x: issue("x", { scopeId: "trk_2" }),
      },
    });
    const cols = buildBoard(data, { scope: tv, query: "", mode: "stage", github: null });
    expect(keys(cols)).toEqual({
      not_started: ["i:i0"],
      working: expect.arrayContaining(["b:prj_1:feat/w1", "b:prj_1:feat/w2"]),
      in_review: [],
      merged: [],
    });
    expect(cols[1]!.cards).toHaveLength(2);
    const card = (k: string) => cols[1]!.cards.find((c) => c.key === k)!;
    expect(card("b:prj_1:feat/w1").leaves).toBe(true);
    expect(card("b:prj_1:feat/w2").leaves).toBe(false);
  });

  it("uses the GitHub board's columns, with No status and Not on the board", () => {
    const issues = {
      i0: issue("i0", { board: board("Todo") }),
      i2: issue("i2", { workspaceId: "w2", board: board(null) }),
    };
    const cols = buildBoard(input({ issues }), {
      scope: null,
      query: "",
      mode: "github",
      github: github(),
    });
    expect(cols.map((c) => c.label)).toEqual(["Todo", "Doing", "No status", "Not on the board"]);
    expect(keys(cols)).toEqual({
      "o-Todo": ["i:i0"],
      "o-Doing": [],
      none: ["b:prj_1:feat/w2"],
      off: expect.arrayContaining(["b:prj_1:feat/w1", "b:prj_1:feat/w3"]),
    });
  });

  it("lists not-started issues by priority, then number, and finds them by priority", () => {
    const ranked = (id: string, number: number, rank: number | null) =>
      issue(id, {
        number,
        board: rank === null ? null : { ...board("Todo"), priority: { name: `P${rank}`, rank } },
      });
    const issues = {
      none: ranked("none", 1, null),
      r2: ranked("r2", 2, 2),
      r0: ranked("r0", 3, 0),
    };
    const cols = buildBoard(input({ issues, workspaces: {}, sessions: {} }), {
      scope: null,
      query: "",
      mode: "stage",
      github: null,
    });
    expect(cols[0]!.cards.map((c) => c.key)).toEqual(["i:r0", "i:r2", "i:none"]);
    const found = buildBoard(input({ issues, workspaces: {}, sessions: {} }), {
      scope: null,
      query: "p0",
      mode: "stage",
      github: null,
    });
    expect(found[0]!.cards.map((c) => c.key)).toEqual(["i:r0"]);
  });

  it("hides an empty backlog column on the GitHub board", () => {
    const withBacklog = github({
      board: {
        projectNumber: 4,
        statusField: "Status",
        onStart: null,
        onReview: null,
        backlog: ["todo"],
      },
    });
    const run = (issues: Record<string, TrackedIssue>) =>
      buildBoard(input({ issues }), {
        scope: null,
        query: "",
        mode: "github",
        github: withBacklog,
      });
    const none = run({ i0: issue("i0", { board: board("Doing") }) });
    expect(none.map((c) => c.label)).toEqual(["Doing", "No status", "Not on the board"]);
    const some = run({ i0: issue("i0", { board: board("Todo") }) });
    expect(some.map((c) => c.label)).toContain("Todo");
  });

  it("offers the GitHub board only for a GitHub scope with a board", () => {
    const issues = [issue("i0", { board: board("Todo") })];
    expect(githubBoardOf(github(), issues)?.options).toHaveLength(2);
    expect(githubBoardOf(github(), issues)?.scope.id).toBe("trk_1");
    expect(githubBoardOf(scope(), issues)).toBeNull();
    expect(githubBoardOf(github({ board: null }), issues)).toBeNull();
    expect(githubBoardOf(github(), [issue("i0")])).toBeNull();
  });

  it("a stored tracker board mode reads as github", () => {
    expect(boardMode("tracker")).toBe("github");
    expect(boardMode("github")).toBe("github");
    expect(boardMode("stage")).toBe("stage");
    expect(boardMode(undefined)).toBe("stage");
  });

  it("allows only the drops that mean something", () => {
    const stage = buildBoard(input(), { scope: null, query: "", mode: "stage", github: null });
    const [notStarted, working, review] = stage;
    const issueCard = notStarted!.cards[0]!;
    const branchCard = working!.cards[0]!;
    expect(canDrop(issueCard, working!, "stage", null)).toEqual({ ok: true });
    expect(canDrop(issueCard, review!, "stage", null)).toMatchObject({ ok: false });
    expect(canDrop(branchCard, review!, "stage", null)).toEqual({
      ok: false,
      reason: "Moves when the branch or its pull request changes",
    });
    const issues = { i0: issue("i0", { board: board("Todo") }) };
    const cols = buildBoard(input({ issues }), {
      scope: null,
      query: "",
      mode: "github",
      github: github(),
    });
    const card = cols[0]!.cards[0]!;
    expect(canDrop(card, cols[1]!, "github", github())).toEqual({ ok: true });
    expect(canDrop(card, cols[1]!, "github", github({ writeBack: false }))).toEqual({
      ok: false,
      reason: "Write-back is off for this scope",
    });
    expect(canDrop(card, cols[2]!, "github", github())).toEqual({
      ok: false,
      reason: "Pick a board column",
    });
    const offCard = cols[3]!.cards[0]!;
    expect(canDrop(offCard, cols[1]!, "github", github())).toEqual({
      ok: false,
      reason: "This branch has no issue on the board",
    });
  });
});
