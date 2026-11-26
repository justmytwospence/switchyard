import { describe, expect, it } from "vitest";
import {
  GitState,
  Project,
  Task,
  TrackedIssue,
  TrackerInput,
  trackerBacklog,
  trackerFollow,
  View,
} from "../src/index.js";

const T = "2026-11-02T10:00:00.000Z";

describe("tracker schemas", () => {
  it("fills tracker defaults", () => {
    expect(TrackerInput.parse({ name: "fg", hostId: "hst_1", owner: "fieldgoalco" })).toEqual({
      name: "fg",
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
    const followed = TrackerInput.parse({
      name: "p",
      hostId: "h",
      owner: "me",
      board: { projectNumber: 4, backlog: ["Backlog"] },
      follow: "board",
    });
    expect(followed.follow).toBe("board");
    expect(followed.board?.backlog).toEqual(["Backlog"]);
    expect(
      TrackerInput.parse({
        name: "vo",
        hostId: "h",
        owner: "VO-Health",
        board: { projectNumber: 3 },
      }).board,
    ).toEqual({ projectNumber: 3, statusField: "Status", onStart: null, onReview: null });
    expect(TrackerInput.safeParse({ name: "x", hostId: "h", owner: "-bad" }).success).toBe(false);
  });

  it("reads follow and backlog safely from stored trackers", () => {
    expect(trackerFollow({ board: null, follow: "board" })).toBe("assigned");
    expect(trackerFollow({ board: null })).toBe("assigned");
    const board = { projectNumber: 1, statusField: "Status", onStart: null, onReview: null };
    expect(trackerFollow({ board, follow: "board" })).toBe("board");
    expect(trackerBacklog({ board: null })).toEqual([]);
    expect(trackerBacklog({ board })).toEqual([]);
    expect(trackerBacklog({ board: { ...board, backlog: ["Backlog"] } })).toEqual(["Backlog"]);
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
      View.safeParse({
        id: "viw_1",
        name: "v",
        mode: "all",
        projectIds: null,
        hostIds: null,
        sessionIds: [],
        clients: [],
        createdAt: T,
        updatedAt: T,
      }).success,
    ).toBe(true);
    expect(
      GitState.safeParse({ dirty: false, changedFiles: 0, ahead: 0, behind: 0, unmerged: false })
        .success,
    ).toBe(true);
    expect("tracker" in Task.shape).toBe(false);
  });

  it("parses a tracked issue", () => {
    const issue = {
      id: "trk_1:I_1",
      trackerId: "trk_1",
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
});
