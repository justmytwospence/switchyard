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
      board: { projectNumber: 1, statusField: "Status", onStart: "In Progress", onReview: null },
      writeBack: true,
      moveShared: true,
      enabled: true,
    });
    expect(draftOf(null, "hst_x")).toMatchObject({ hostId: "hst_x", statusField: "Status" });
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
    expect(validateDraft({ ...ok, board: "0" }).board).toBe(
      "Enter the board's number, as in its URL.",
    );
  });

  it("states the facts", () => {
    expect(trackerFacts(tracker(), "Mac")).toEqual([
      ["GitHub", "VO-Health: VO-Health/datasync"],
      ["Signed in as", "me"],
      ["Host", "Mac"],
      ["Board", "#1, field Status"],
      ["Moves cards", 'To "In Progress" when work starts'],
    ]);
    const plain = trackerFacts(
      tracker({ repositories: null, board: null, writeBack: false, login: null }),
      "Mac",
    );
    expect(plain).toEqual([
      ["GitHub", "VO-Health (all repositories)"],
      ["Signed in as", "Not synced yet"],
      ["Host", "Mac"],
      ["Board", "None"],
      ["Moves cards", "Off"],
    ]);
    expect(
      trackerFacts(
        tracker({
          moveShared: false,
          board: { projectNumber: 1, statusField: "Status", onStart: null, onReview: "Review" },
        }),
        "Mac",
      )[4],
    ).toEqual(["Moves cards", 'To "Review" when a pull request opens; never shared cards']);
  });
});
