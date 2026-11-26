import { describe, expect, it } from "vitest";
import {
  CLIENT_OPEN_MS,
  findScope,
  type GitHubSource,
  issueBranchSet,
  issueBranchSetHas,
  openClients,
  Scope,
  type Session,
  sessionInScope,
  sessionScopeReason,
  taskInScope,
} from "../src/index.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");

const GITHUB: GitHubSource = {
  kind: "github",
  hostId: "hst_1",
  owner: "acme",
  repositories: null,
  board: null,
  writeBack: false,
  moveShared: true,
  enabled: true,
  login: null,
  lastSyncedAt: null,
  lastError: null,
};

function scope(over: Partial<Scope> = {}): Scope {
  return {
    id: "viw_1",
    name: "work",
    mode: "all",
    projectIds: null,
    hostIds: null,
    sessionIds: [],
    source: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

const s = (over: Record<string, unknown> = {}) => ({
  id: "ses_1",
  projectId: "prj_a" as string | null,
  workspaceId: "wsp_1" as string | null,
  hostId: "hst_1",
  archivedAt: null as string | null,
  runtime: "idle" as Session["runtime"],
  ...over,
});

describe("sessionInScope", () => {
  it("never includes archived sessions", () => {
    expect(sessionInScope(scope({ sessionIds: ["ses_1"] }), s({ archivedAt: "x" }), {})).toBe(
      false,
    );
  });
  it("pinned mode only has pinned sessions", () => {
    expect(sessionInScope(scope({ mode: "pinned", sessionIds: ["ses_1"] }), s(), {})).toBe(true);
    expect(sessionInScope(scope({ mode: "pinned" }), s(), {})).toBe(false);
  });
  it("all mode with null filters includes everything", () => {
    expect(sessionInScope(scope(), s(), {})).toBe(true);
  });
  it("matches projects through the workspace", () => {
    const v = scope({ projectIds: ["prj_b"] });
    const x = s({ projectId: null });
    expect(sessionInScope(v, x, { wsp_1: { projectId: "prj_b" } })).toBe(true);
    expect(sessionInScope(v, x, new Map([["wsp_1", { projectId: "prj_b" }]]))).toBe(true);
    expect(sessionInScope(v, x, {})).toBe(false);
  });
  it("filters by host", () => {
    expect(sessionInScope(scope({ hostIds: ["hst_2"] }), s(), {})).toBe(false);
  });
  it("drops fields a stored view had and a scope does not", () => {
    const parsed = Scope.parse({ ...scope(), clientId: "herdr:x@mac", trackerId: "trk_1" });
    expect("clientId" in parsed).toBe(false);
    expect("trackerId" in parsed).toBe(false);
  });
  it("a pin beats the filters", () => {
    expect(
      sessionInScope(
        scope({ projectIds: ["prj_z"], hostIds: ["hst_2"], sessionIds: ["ses_1"] }),
        s(),
        {},
      ),
    ).toBe(true);
  });
});

describe("GitHub scopes", () => {
  const v = scope({ id: "trk_1", source: GITHUB, projectIds: ["prj_a"] });
  const ws = {
    wsp_1: { projectId: "prj_a", branch: "feat/x" },
    wsp_2: { projectId: "prj_a", branch: "other" },
  };
  const issue = (over: Record<string, unknown> = {}) => ({
    scopeId: "trk_1",
    projectId: "prj_a",
    workspaceId: null as string | null,
    branch: null as string | null,
    branches: [] as string[],
    ...over,
  });
  const stopped = { runtime: "stopped" as const };

  it("issueBranchSet is null without a source and collects workspaces and branches", () => {
    expect(issueBranchSet(scope(), [issue()])).toBeNull();
    const issueSet = issueBranchSet(v, [
      issue({ workspaceId: "wsp_9", branch: "a", branches: ["b"] }),
      issue({ scopeId: "trk_2", workspaceId: "wsp_8" }),
    ])!;
    expect([...issueSet.workspaceIds]).toEqual(["wsp_9"]);
    expect([...issueSet.branches].sort()).toEqual(["prj_a\na", "prj_a\nb"]);
  });
  it("a stopped session on an issue's workspace is in the scope", () => {
    const issueSet = issueBranchSet(v, [issue({ workspaceId: "wsp_1" })]);
    expect(sessionInScope(v, s(stopped), ws, issueSet)).toBe(true);
  });
  it("a stopped session on an issue's branch name is in the scope", () => {
    const issueSet = issueBranchSet(v, [issue({ branches: ["feat/x"] })]);
    expect(sessionInScope(v, s(stopped), ws, issueSet)).toBe(true);
  });
  it("a live session with no issue is in the scope; a stopped one is not", () => {
    const issueSet = issueBranchSet(v, []);
    expect(sessionInScope(v, s({ runtime: "running" }), ws, issueSet)).toBe(true);
    expect(sessionInScope(v, s(stopped), ws, issueSet)).toBe(false);
    expect(sessionInScope(v, s({ ...stopped, workspaceId: null }), ws, issueSet)).toBe(false);
  });
  it("a live session in another project is not in the scope", () => {
    const issueSet = issueBranchSet(v, []);
    expect(sessionInScope(v, s({ projectId: "prj_b" }), ws, issueSet)).toBe(false);
  });
  it("without its issue branches a GitHub scope falls back to its projects", () => {
    expect(sessionInScope(v, s(stopped), ws)).toBe(true);
  });
  it("a pin still wins", () => {
    const issueSet = issueBranchSet(v, []);
    expect(sessionInScope({ ...v, sessionIds: ["ses_1"] }, s(stopped), ws, issueSet)).toBe(true);
  });
  it("sessionScopeReason names pin, issue, live and filter", () => {
    const issueSet = issueBranchSet(v, [issue({ workspaceId: "wsp_1" })]);
    expect(sessionScopeReason({ ...v, sessionIds: ["ses_1"] }, s(stopped), ws, issueSet)).toBe(
      "pinned",
    );
    expect(sessionScopeReason(v, s(stopped), ws, issueSet)).toBe("issue");
    expect(sessionScopeReason(v, s(), ws, issueSet)).toBe("issue");
    expect(sessionScopeReason(v, s({ workspaceId: "wsp_2" }), ws, issueSet)).toBe("live");
    expect(sessionScopeReason(v, s({ ...stopped, workspaceId: "wsp_2" }), ws, issueSet)).toBeNull();
    expect(sessionScopeReason(scope(), s(stopped), ws)).toBe("filter");
  });
  it("issueBranchSetHas matches by id or branch", () => {
    const issueSet = issueBranchSet(v, [issue({ workspaceId: "wsp_9", branches: ["feat/x"] })])!;
    expect(issueBranchSetHas(issueSet, { id: "wsp_9", projectId: "prj_z" })).toBe(true);
    expect(issueBranchSetHas(issueSet, { id: "wsp_1", projectId: "prj_a", branch: "feat/x" })).toBe(
      true,
    );
    expect(issueBranchSetHas(issueSet, { id: "wsp_2", projectId: "prj_a", branch: "other" })).toBe(
      false,
    );
  });
});

describe("findScope", () => {
  it("finds by id, then case-insensitive name, and not when ambiguous", () => {
    const a = scope();
    const b = scope({ id: "viw_2", name: "Play" });
    expect(findScope([a, b], "viw_2")).toBe(b);
    expect(findScope([a, b], "WORK")).toBe(a);
    expect(findScope([a, scope({ id: "viw_3", name: "WORK" })], "work")).toBeNull();
    expect(findScope([a], "nope")).toBeNull();
  });
});

describe("openClients", () => {
  it("keeps recent clients mirroring this scope, sorted by kind then name", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const c = (
      id: string,
      kind: string,
      name: string,
      lastSeenAt: string,
      scopeId: string | null = "viw_1",
      mirror: "scope" | "all" | "none" = "scope",
    ) => ({
      id,
      kind,
      name,
      machine: "m",
      deviceId: "dev_1",
      hostId: null,
      scopeId,
      mirror,
      lastSeenAt,
      createdAt: at(CLIENT_OPEN_MS * 2),
    });
    const clients = [
      c("1", "tmux", "a", at(1000)),
      c("2", "herdr", "z", at(1000)),
      c("3", "herdr", "old", at(CLIENT_OPEN_MS + 1)),
      c("4", "herdr", "elsewhere", at(1000), "viw_2"),
      c("5", "herdr", "everything", at(1000), null, "all"),
      c("6", "herdr", "recorded", at(1000)),
      c("7", "zellij", "other", at(1000)),
    ];
    expect(openClients(clients, "viw_1", NOW).map((x) => x.id)).toEqual(["6", "2", "1", "7"]);
  });
});

describe("taskInScope", () => {
  const t = (over: { projectId?: string; sessionId?: string | null } = {}) => ({
    projectId: "prj_a",
    sessionId: null as string | null,
    ...over,
  });
  it("matches by project in an all scope, with any project when unlimited", () => {
    expect(taskInScope(scope(), t())).toBe(true);
    expect(taskInScope(scope({ projectIds: ["prj_a"] }), t())).toBe(true);
    expect(taskInScope(scope({ projectIds: ["prj_b"] }), t())).toBe(false);
  });
  it("ignores host filters", () => {
    expect(taskInScope(scope({ hostIds: ["hst_9"] }), t())).toBe(true);
  });
  it("in a pinned scope, only tasks whose session is pinned", () => {
    expect(taskInScope(scope({ mode: "pinned" }), t())).toBe(false);
    expect(
      taskInScope(scope({ mode: "pinned", sessionIds: ["ses_1"] }), t({ sessionId: "ses_1" })),
    ).toBe(true);
    expect(
      taskInScope(
        scope({ projectIds: ["prj_b"], sessionIds: ["ses_1"] }),
        t({ sessionId: "ses_1" }),
      ),
    ).toBe(true);
  });
});
