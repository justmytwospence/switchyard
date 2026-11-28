import { describe, expect, it } from "vitest";
import {
  ClientKind,
  GitHubSource,
  GitHubSourceInput,
  GitState,
  HostCommand,
  IssueDescriptionRequest,
  IssueDescriptionResult,
  Project,
  RepoIssueRequest,
  RepoIssuesPageRequest,
  Scope,
  sourceBacklog,
  sourceFollow,
  Task,
  TrackedIssue,
} from "../src/index.js";

const T = "2026-11-02T10:00:00.000Z";

describe("strict issue branch commands", () => {
  it("preserves and validates the optional strict flag", () => {
    for (const command of [
      { type: "tracker.prepareBranch", checkoutPath: "/repo", branch: "topic" },
      {
        type: "tracker.startIssue",
        checkoutPath: "/repo",
        repository: "acme/app",
        number: 1,
        branch: "topic",
        base: "main",
      },
    ]) {
      expect(HostCommand.parse({ ...command, strict: true })).toMatchObject({ strict: true });
      expect(HostCommand.parse(command)).not.toHaveProperty("strict");
      expect(HostCommand.safeParse({ ...command, strict: "yes" }).success).toBe(false);
    }
  });
});

describe("repository issue requests", () => {
  it("bounds cursors and rejects caller-controlled fields", () => {
    expect(
      RepoIssuesPageRequest.safeParse({ repository: "acme/app", after: "x".repeat(2049) }).success,
    ).toBe(false);
    expect(
      RepoIssuesPageRequest.safeParse({ repository: "acme/app", query: "is:open" }).success,
    ).toBe(false);
    expect(
      RepoIssueRequest.safeParse({ repository: "acme/app", number: 1, checkoutPath: "/tmp" })
        .success,
    ).toBe(false);
    expect(
      HostCommand.safeParse({ type: "tracker.repoIssue", repository: "acme/app", number: 1 })
        .success,
    ).toBe(true);
  });
});

describe("issue description schemas", () => {
  it("validates locator and bounded body", () => {
    expect(IssueDescriptionRequest.safeParse({ repository: "acme/app", number: 1 }).success).toBe(
      true,
    );
    for (const input of [
      { repository: "../app", number: 1 },
      { repository: "acme/app", number: 0 },
      { repository: "acme/app", number: 1.5 },
    ])
      expect(IssueDescriptionRequest.safeParse(input).success).toBe(false);
    expect(
      IssueDescriptionResult.safeParse({ body: "x".repeat(32769), truncated: true }).success,
    ).toBe(false);
  });
});

describe("GitHub source schemas", () => {
  it("fills source defaults", () => {
    expect(GitHubSourceInput.parse({ hostId: "hst_1", owner: "fieldgoalco" })).toEqual({
      hostId: "hst_1",
      owner: "fieldgoalco",
      repositories: null,
      extraRepositories: [],
      board: null,
      follow: "assigned",
      writeBack: false,
      moveShared: true,
      worktrees: true,
      enabled: true,
    });
    const followed = GitHubSourceInput.parse({
      hostId: "h",
      owner: "me",
      board: { projectNumber: 4, backlog: ["Backlog"] },
      follow: "board",
    });
    expect(followed.follow).toBe("board");
    expect(followed.board?.backlog).toEqual(["Backlog"]);
    expect(
      GitHubSourceInput.parse({
        hostId: "h",
        owner: "VO-Health",
        board: { projectNumber: 3 },
      }).board,
    ).toEqual({ projectNumber: 3, statusField: "Status", onStart: null, onReview: null });
    expect(GitHubSourceInput.safeParse({ hostId: "h", owner: "-bad" }).success).toBe(false);
  });

  it("reads follow and backlog safely from stored sources", () => {
    expect(sourceFollow({ board: null, follow: "board" })).toBe("assigned");
    expect(sourceFollow({ board: null })).toBe("assigned");
    const board = { projectNumber: 1, statusField: "Status", onStart: null, onReview: null };
    expect(sourceFollow({ board, follow: "board" })).toBe("board");
    expect(sourceBacklog({ board: null })).toEqual([]);
    expect(sourceBacklog({ board })).toEqual([]);
    expect(sourceBacklog({ board: { ...board, backlog: ["Backlog"] } })).toEqual(["Backlog"]);
  });

  it("keeps older entities valid", () => {
    const project = Project.parse({
      id: "prj_1",
      name: "App",
      repoIdentity: "https://github.com/acme/app",
      defaultProfileId: null,
      defaultHostId: null,
      maxConcurrentRuns: 1,
      automationEnabled: true,
      setupCommand: null,
      checks: [],
      workspaceSharing: "single_writer",
      createdAt: T,
      updatedAt: T,
    });
    expect(project).toMatchObject({ ensureSessions: false, removeLanded: false });
    expect(
      GitState.safeParse({ dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false })
        .success,
    ).toBe(true);
    expect("tracker" in Task.shape).toBe(false);
  });

  it("parses a tracked issue", () => {
    const issue = {
      id: "trk_1:I_1",
      scopeId: "trk_1",
      itemId: "I_1",
      projectId: "prj_1",
      repository: "acme/app",
      number: 1,
      title: "Fix it",
      url: "https://github.com/acme/app/issues/1",
      assignees: ["me"],
      branches: [],
      branch: null,
      workspaceId: null,
      pullRequest: null,
      board: null,
      updatedAt: T,
    };
    expect(TrackedIssue.parse(issue)).toEqual(issue);
    const full = {
      ...issue,
      board: {
        projectId: "P",
        projectItemId: "PI",
        fieldId: "F",
        status: "Ready",
        statusOptionId: "o1",
        options: [{ id: "o1", name: "Ready" }],
        priority: { name: "P1", rank: 1 },
      },
      parent: { number: 39, title: "Epic", url: "https://github.com/acme/app/issues/39" },
      subIssues: { total: 3, completed: 1 },
    };
    expect(TrackedIssue.parse(full)).toEqual(full);
  });

  it("Scope parses with no source and with a GitHub source", () => {
    const scope = {
      id: "scp_1",
      name: "work",
      mode: "all",
      projectIds: null,
      hostIds: null,
      sessionIds: [],
      source: null,
      createdAt: T,
      updatedAt: T,
    };
    expect(Scope.parse(scope)).toEqual(scope);
    const source = GitHubSource.parse({
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
    });
    expect(Scope.parse({ ...scope, projectIds: [], source }).source).toEqual(source);
    expect(Scope.safeParse({ ...scope, source: { ...source, kind: "linear" } }).success).toBe(
      false,
    );
    expect(Scope.safeParse({ ...scope, source: undefined }).success).toBe(false);
  });

  it("ClientKind accepts another module's kind and rejects uppercase", () => {
    for (const kind of ["herdr", "tmux", "zellij", "my-mux2"])
      expect(ClientKind.safeParse(kind).success).toBe(true);
    for (const kind of ["Herdr", "", "2mux", "a b", "x".repeat(33)])
      expect(ClientKind.safeParse(kind).success).toBe(false);
  });
});
