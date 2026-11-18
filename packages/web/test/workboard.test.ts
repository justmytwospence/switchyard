import type {
  Host,
  Project,
  Session,
  TrackedIssue,
  Tracker,
  View,
  Workspace,
} from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardInput,
  buildBoard,
  canDrop,
  trackerBoardOf,
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
    trackerId: "trk_1",
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

const view = (over: Partial<View> = {}): View =>
  ({
    id: "viw_1",
    name: "v",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    clients: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }) as View;

const tracker = (over: Partial<Tracker> = {}): Tracker =>
  ({
    id: "trk_1",
    name: "personal",
    board: { projectNumber: 4, statusField: "Status", onStart: null, onReview: null },
    writeBack: true,
    ...over,
  }) as Tracker;

const keys = (cols: ReturnType<typeof buildBoard>) =>
  Object.fromEntries(cols.map((c) => [c.id, c.cards.map((x) => x.key)]));

describe("work board", () => {
  it("puts branches and issues in stage columns from facts", () => {
    const cols = buildBoard(input(), { view: null, query: "", mode: "stage", tracker: null });
    expect(cols.map((c) => c.label)).toEqual(["Not started", "Working", "In review", "Merged"]);
    expect(keys(cols)).toEqual({
      not_started: ["i:i0"],
      working: ["b:prj_1:feat/w1"],
      in_review: ["b:prj_1:feat/w2"],
      merged: ["b:prj_1:feat/w3"],
    });
    const w1 = cols[1]!.cards[0]!;
    expect(w1).toMatchObject({ sessionId: "a", branchLabel: "feat/w1", host: null });
  });

  it("shows a main checkout only when it has a session", () => {
    const cols = buildBoard(
      input({
        sessions: { m: session("m", { workspaceId: "wm" }) } as Record<string, Session>,
      }),
      { view: null, query: "", mode: "stage", tracker: null },
    );
    const main = cols[1]!.cards.find((c) => c.key === "b:prj_1:main")!;
    expect(main.branchLabel).toBeNull();
    const without = buildBoard(input({ sessions: {} }), {
      view: null,
      query: "",
      mode: "stage",
      tracker: null,
    });
    expect(without[1]!.cards.some((c) => c.key === "b:prj_1:main")).toBe(false);
  });

  it("filters branches and issues by the view and the search", () => {
    const other = buildBoard(input(), {
      view: view({ projectIds: ["prj_2"] }),
      query: "",
      mode: "stage",
      tracker: null,
    });
    expect(other.every((c) => c.cards.length === 0)).toBe(true);
    const found = buildBoard(input(), { view: null, query: "#7", mode: "stage", tracker: null });
    expect(found[0]!.cards).toHaveLength(1);
  });

  it("uses the tracker board's columns, with No status and Not on the board", () => {
    const issues = {
      i0: issue("i0", { board: board("Todo") }),
      i2: issue("i2", { workspaceId: "w2", board: board(null) }),
    };
    const cols = buildBoard(input({ issues }), {
      view: null,
      query: "",
      mode: "tracker",
      tracker: tracker(),
    });
    expect(cols.map((c) => c.label)).toEqual(["Todo", "Doing", "No status", "Not on the board"]);
    expect(keys(cols)).toEqual({
      "o-Todo": ["i:i0"],
      "o-Doing": [],
      none: ["b:prj_1:feat/w2"],
      off: expect.arrayContaining(["b:prj_1:feat/w1", "b:prj_1:feat/w3"]),
    });
  });

  it("offers the tracker board only for a tracker's view with a board", () => {
    const issues = [issue("i0", { board: board("Todo") })];
    expect(trackerBoardOf(view({ trackerId: "trk_1" }), [tracker()], issues)?.options).toHaveLength(
      2,
    );
    expect(trackerBoardOf(view(), [tracker()], issues)).toBeNull();
    expect(
      trackerBoardOf(view({ trackerId: "trk_1" }), [tracker({ board: null })], issues),
    ).toBeNull();
    expect(trackerBoardOf(view({ trackerId: "trk_1" }), [tracker()], [issue("i0")])).toBeNull();
  });

  it("allows only the drops that mean something", () => {
    const stage = buildBoard(input(), { view: null, query: "", mode: "stage", tracker: null });
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
      view: null,
      query: "",
      mode: "tracker",
      tracker: tracker(),
    });
    const card = cols[0]!.cards[0]!;
    expect(canDrop(card, cols[1]!, "tracker", tracker())).toEqual({ ok: true });
    expect(canDrop(card, cols[1]!, "tracker", tracker({ writeBack: false }))).toEqual({
      ok: false,
      reason: "Write-back is off for this tracker",
    });
    expect(canDrop(card, cols[2]!, "tracker", tracker())).toEqual({
      ok: false,
      reason: "Pick a board column",
    });
    const offCard = cols[3]!.cards[0]!;
    expect(canDrop(offCard, cols[1]!, "tracker", tracker())).toEqual({
      ok: false,
      reason: "This branch has no issue on the board",
    });
  });
});
