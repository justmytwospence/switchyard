import { describe, expect, it } from "vitest";
import { GitState, Project, Task, TrackerInput, View } from "../src/index.js";

const T = "2026-11-02T10:00:00.000Z";

describe("tracker schemas", () => {
  it("fills tracker defaults", () => {
    expect(TrackerInput.parse({ name: "fg", hostId: "hst_1", owner: "fieldgoalco" })).toEqual({
      name: "fg",
      hostId: "hst_1",
      owner: "fieldgoalco",
      repositories: null,
      board: null,
      writeBack: false,
      moveShared: true,
      enabled: true,
    });
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
    expect(Task.shape.tracker.safeParse(undefined).success).toBe(true);
  });
});
