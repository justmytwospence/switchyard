import type { Tracker } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  bodyOf,
  draftOf,
  trackerFacts,
  validateDraft,
} from "../src/features/settings/trackerLogic";

const T = "2026-11-02T10:00:00.000Z";
const tracker = (over: Partial<Tracker> = {}): Tracker => ({
  id: "trk_1",
  name: "vo",
  provider: "github",
  hostId: "hst_1",
  owner: "VO-Health",
  repositories: ["VO-Health/datasync"],
  board: { projectNumber: 1, statusField: "Status", onStart: "In Progress", onReview: null },
  writeBack: true,
  moveShared: true,
  enabled: true,
  login: "me",
  lastSyncedAt: T,
  lastError: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe("tracker form", () => {
  it("round-trips a tracker through the draft", () => {
    const t = tracker();
    expect(bodyOf(draftOf(t, "hst_x"))).toEqual({
      name: "vo",
      hostId: "hst_1",
      owner: "VO-Health",
      repositories: ["VO-Health/datasync"],
      extraRepositories: [],
      board: {
        projectNumber: 1,
        statusField: "Status",
        onStart: "In Progress",
        onReview: null,
        backlog: [],
        priorityField: null,
      },
      follow: "assigned",
      writeBack: true,
      moveShared: true,
      enabled: true,
    });
    const followed = tracker({
      follow: "board",
      board: {
        projectNumber: 4,
        statusField: "Status",
        onStart: null,
        onReview: null,
        backlog: ["Backlog", "Icebox"],
      },
    });
    const ranked = tracker({
      board: {
        projectNumber: 1,
        statusField: "Status",
        onStart: null,
        onReview: null,
        priorityField: "Priority",
      },
    });
    expect(bodyOf(draftOf(ranked, "h")).board?.priorityField).toBe("Priority");
    expect(trackerFacts(ranked, "Mac")[4]).toEqual([
      "Board",
      "#1, field Status, priority Priority",
    ]);
    expect(draftOf(followed, "h")).toMatchObject({ follow: "board", backlog: "Backlog, Icebox" });
    expect(bodyOf(draftOf(followed, "h"))).toMatchObject({
      follow: "board",
      board: { backlog: ["Backlog", "Icebox"] },
    });
    expect(bodyOf({ ...draftOf(followed, "h"), board: "" }).follow).toBe("assigned");
    expect(draftOf(null, "hst_x")).toMatchObject({ hostId: "hst_x", statusField: "Status" });
    expect(bodyOf(draftOf(null, "h")).extraRepositories).toEqual([]);
    const extra = tracker({ extraRepositories: ["other/lib", "other/app"] });
    expect(bodyOf(draftOf(extra, "h")).extraRepositories).toEqual(["other/lib", "other/app"]);
  });

  it("drops the board and write-back without a board number", () => {
    const d = { ...draftOf(tracker(), "h"), board: " ", repositories: "\n" };
    expect(bodyOf(d)).toMatchObject({ board: null, writeBack: false, repositories: null });
  });

  it("explains each invalid field", () => {
    const ok = draftOf(tracker(), "h");
    expect(validateDraft(ok)).toEqual({});
    expect(validateDraft({ ...ok, name: " " }).name).toBe("Enter a name.");
    expect(validateDraft({ ...ok, name: "x".repeat(61) }).name).toBe("Use 60 characters or fewer.");
    expect(validateDraft({ ...ok, hostId: "" }).hostId).toBe("Choose a host.");
    expect(validateDraft({ ...ok, owner: "-bad" }).owner).toBe(
      "Enter a GitHub organization or user name.",
    );
    expect(validateDraft({ ...ok, repositories: "nope" }).repositories).toBe(
      "Use owner/name, one per line.",
    );
    expect(validateDraft({ ...ok, extraRepositories: "nope" }).extraRepositories).toBe(
      "Use owner/name, one per line.",
    );
    const many = Array.from({ length: 21 }, (_, i) => `o/r${i}`).join("\n");
    expect(validateDraft({ ...ok, extraRepositories: many }).extraRepositories).toBe(
      "Use 20 repositories or fewer.",
    );
    const columns = Array.from({ length: 21 }, (_, i) => `c${i}`).join(",");
    expect(validateDraft({ ...ok, backlog: columns }).backlog).toBe("Use 20 columns or fewer.");
    expect(validateDraft({ ...ok, board: "0" }).board).toBe(
      "Enter the board's number, as in its URL.",
    );
  });

  it("states the facts", () => {
    expect(trackerFacts(tracker(), "Mac")).toEqual([
      ["GitHub", "VO-Health: VO-Health/datasync"],
      ["Follows", "Issues assigned to me"],
      ["Signed in as", "me"],
      ["Host", "Mac"],
      ["Board", "#1, field Status"],
      ["Moves cards", 'To "In Progress" when work starts'],
    ]);
    const plain = trackerFacts(
      tracker({ repositories: null, board: null, writeBack: false, login: null }),
      "Mac",
    );
    expect(
      trackerFacts(tracker({ repositories: null, extraRepositories: ["other/lib"] }), "Mac")[0],
    ).toEqual(["GitHub", "VO-Health (all repositories), plus other/lib"]);
    expect(plain).toEqual([
      ["GitHub", "VO-Health (all repositories)"],
      ["Follows", "Issues assigned to you"],
      ["Signed in as", "Not synced yet"],
      ["Host", "Mac"],
      ["Board", "None"],
      ["Moves cards", "Off"],
    ]);
    const board = { projectNumber: 4, statusField: "Status", onStart: null, onReview: null };
    const facts = trackerFacts(
      tracker({ follow: "board", board: { ...board, backlog: ["Backlog"] } }),
      "Mac",
    );
    expect(facts[1]).toEqual(["Follows", "Every open issue on the board"]);
    expect(facts[4]).toEqual(["Board", "#4, field Status; hides Backlog until started"]);
    expect(
      trackerFacts(
        tracker({
          moveShared: false,
          board: { projectNumber: 1, statusField: "Status", onStart: null, onReview: "Review" },
        }),
        "Mac",
      )[5],
    ).toEqual(["Moves cards", 'To "Review" when a pull request opens; never shared cards']);
  });
});
