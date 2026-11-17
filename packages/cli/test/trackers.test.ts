import { describe, expect, it } from "vitest";
import {
  trackersCreate,
  trackersEdit,
  trackersList,
  trackersSync,
} from "../src/commands/trackers.js";
import { stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };
const T = "2026-11-02T10:00:00.000Z";
const HOST = {
  id: "hst_1",
  name: "Mac",
  platform: "darwin",
  agentVersion: "0.15.0",
  piVersion: "1.5.0",
  piCompatible: true,
  capabilities: null,
  connectivity: "connected",
  lastSeenAt: T,
  revokedAt: null,
  createdAt: T,
};
const TRACKER = {
  id: "trk_1",
  name: "vo",
  provider: "github",
  hostId: "hst_1",
  owner: "VO-Health",
  repositories: null,
  board: { projectNumber: 3, statusField: "Status", onStart: "Doing", onReview: null },
  writeBack: true,
  moveShared: true,
  enabled: true,
  login: "me",
  lastSyncedAt: T,
  lastError: null,
  createdAt: T,
  updatedAt: T,
};

function setup() {
  return stubFetch({
    "GET /api/hosts": () => [HOST],
    "GET /api/trackers": () => [TRACKER],
    "POST /api/trackers": (c) => ({ status: 201, body: { ...TRACKER, ...(c.body as object) } }),
    "PATCH /api/trackers/trk_1": (c) => ({ ...TRACKER, ...(c.body as object) }),
    "POST /api/trackers/trk_1/sync": () => TRACKER,
    "GET /api/tasks": () => [{ id: "t1", tracker: { trackerId: "trk_1" } }, { id: "t2" }],
  });
}

describe("trackers commands", () => {
  it("requires --host and --owner, and board options need --board", async () => {
    const { fetch } = setup();
    const ctx = testCtx(fetch);
    await expect(trackersCreate(ctx, "x", { ...conn, owner: "acme" })).rejects.toThrow(
      "--host is required",
    );
    await expect(trackersCreate(ctx, "x", { ...conn, host: "Mac" })).rejects.toThrow(
      "--owner is required",
    );
    await expect(
      trackersCreate(ctx, "x", { ...conn, host: "Mac", owner: "acme", onStart: "Doing" }),
    ).rejects.toThrow("need --board");
  });

  it("creates a tracker", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await trackersCreate(ctx, "vo", {
      ...conn,
      host: "mac",
      owner: "VO-Health",
      board: "3",
      onStart: "Doing",
      writeBack: true,
      moveShared: false,
    });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "vo",
      hostId: "hst_1",
      owner: "VO-Health",
      board: { projectNumber: 3, onStart: "Doing" },
      writeBack: true,
      moveShared: false,
    });
    expect(ctx.lines).toEqual(["Created tracker vo (trk_1)"]);
  });

  it("edits a tracker", async () => {
    const { fetch, calls } = setup();
    const ctx = testCtx(fetch);
    await trackersEdit(ctx, "VO", { ...conn, onReview: "Review", allRepos: true, disable: true });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      repositories: null,
      board: { projectNumber: 3, statusField: "Status", onStart: "Doing", onReview: "Review" },
      enabled: false,
    });
    await trackersEdit(ctx, "vo", { ...conn, noBoard: true, writeBack: false });
    expect(calls.filter((c) => c.method === "PATCH")[1]!.body).toEqual({
      board: null,
      writeBack: false,
    });
    await expect(trackersEdit(ctx, "nope", conn)).rejects.toThrow(
      'Unknown tracker "nope". Trackers: vo',
    );
    await expect(trackersEdit(ctx, "vo", { ...conn, noBoard: true, board: "2" })).rejects.toThrow(
      "--no-board",
    );
  });

  it("lists and syncs", async () => {
    const { fetch } = setup();
    const ctx = testCtx(fetch);
    await trackersList(ctx, conn);
    expect(ctx.lines[0]).toMatch(/^NAME\s+HOST\s+OWNER\s+REPOS\s+BOARD\s+WRITE-BACK/);
    expect(ctx.lines[1]).toMatch(/^vo\s+Mac\s+VO-Health\s+any\s+#3\s+on/);
    await trackersSync(ctx, "vo", conn);
    expect(ctx.lines.at(-1)).toBe("Synced vo: 1 task");
  });
});
