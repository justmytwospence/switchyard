import { z } from "zod";
import { GitHubIssueUrl, GitHubRepository } from "./github.js";

/**
 * Trackers: a user's GitHub issues (assigned to them, or every open issue on a board) in one owner (optionally some repositories, plus
 * repositories of other owners, optionally with a Projects board), synced into tracked issues that link to branches and worktrees. See docs/trackers.md.
 */

const Iso = z.string();
const Id = z.string().min(1);

/** Host feature: the host answers `tracker.*` commands. */
export const TRACKERS_FEATURE = "trackers.v1";
/** Host feature: tracker.sync can follow a board and skip backlog columns. */
export const TRACKER_BOARD_FEATURE = "trackers.board.v1";

/** Which issues a tracker follows: those assigned to you, or every open issue on its board. */
export const TrackerFollow = z.enum(["assigned", "board"]);
export type TrackerFollow = z.infer<typeof TrackerFollow>;

export const GitHubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const TrackerStatusOption = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
});
export type TrackerStatusOption = z.infer<typeof TrackerStatusOption>;

export const TrackerBoard = z.object({
  projectNumber: z.number().int().positive(),
  statusField: z.string().min(1).max(100).default("Status"),
  /** Column to move a card to once its worktree exists (write-back). */
  onStart: z.string().min(1).max(200).nullable().default(null),
  /** Column to move a card to once a pull request is open (write-back). */
  onReview: z.string().min(1).max(200).nullable().default(null),
  /** A single-select field that ranks issues: its first option is the highest. */
  priorityField: z.string().min(1).max(100).nullable().optional(),
  /** Columns whose cards are not tracked until they have a branch or pull request. */
  backlog: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type TrackerBoard = z.infer<typeof TrackerBoard>;

export const Tracker = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  provider: z.literal("github"),
  hostId: Id,
  owner: GitHubLogin,
  repositories: z.array(GitHubRepository).min(1).max(50).nullable(),
  /** Repositories outside `owner` that belong to this tracker too (never limited by `repositories`). */
  extraRepositories: z.array(GitHubRepository).max(20).optional(),
  board: TrackerBoard.nullable(),
  /** Which issues it follows; absent means "assigned". "board": every open issue on its board. */
  follow: TrackerFollow.optional(),
  writeBack: z.boolean(),
  moveShared: z.boolean(),
  /** Make a worktree for an issue branch that has none; absent means true. */
  worktrees: z.boolean().optional(),
  enabled: z.boolean(),
  /** The host's `gh` user, from the last sync. */
  login: z.string().nullable(),
  lastSyncedAt: Iso.nullable(),
  lastError: z.string().max(2000).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Tracker = z.infer<typeof Tracker>;

/** Stored trackers lack the newer fields: always read them through these. */
export const trackerFollow = (t: Pick<Tracker, "follow" | "board">): TrackerFollow =>
  t.follow === "board" && t.board ? "board" : "assigned";
export const trackerMakesWorktrees = (t: Pick<Tracker, "worktrees">): boolean =>
  t.worktrees !== false;
export const trackerBacklog = (t: Pick<Tracker, "board">): string[] => t.board?.backlog ?? [];

export const TrackerInput = z.object({
  name: Tracker.shape.name,
  hostId: Id,
  owner: GitHubLogin,
  repositories: Tracker.shape.repositories.default(null),
  extraRepositories: z.array(GitHubRepository).max(20).default([]),
  board: TrackerBoard.nullable().default(null),
  follow: TrackerFollow.default("assigned"),
  writeBack: z.boolean().default(false),
  moveShared: z.boolean().default(true),
  worktrees: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type TrackerInput = z.input<typeof TrackerInput>;

export const TrackerPatch = z.object({
  name: Tracker.shape.name.optional(),
  hostId: Id.optional(),
  owner: GitHubLogin.optional(),
  repositories: Tracker.shape.repositories.optional(),
  extraRepositories: z.array(GitHubRepository).max(20).optional(),
  board: TrackerBoard.nullable().optional(),
  follow: TrackerFollow.optional(),
  writeBack: z.boolean().optional(),
  moveShared: z.boolean().optional(),
  worktrees: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type TrackerPatch = z.input<typeof TrackerPatch>;

export const TrackerItemBoard = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1),
  fieldId: z.string().min(1),
  status: z.string().nullable(),
  statusOptionId: z.string().nullable(),
  options: z.array(TrackerStatusOption).max(50),
  /** The issue's value of the tracker's priority field; `rank` is its option's position. */
  priority: z
    .object({ name: z.string().min(1).max(200), rank: z.number().int().min(0) })
    .nullable()
    .optional(),
});
export type TrackerItemBoard = z.infer<typeof TrackerItemBoard>;

export const TrackerPullRequest = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string().url(),
  headRefName: z.string().min(1).max(255),
});
export type TrackerPullRequest = z.infer<typeof TrackerPullRequest>;

export const TrackerParent = z.object({
  number: z.number().int().positive(),
  title: z.string().max(300),
  url: GitHubIssueUrl,
});
export type TrackerParent = z.infer<typeof TrackerParent>;

export const TrackerSubIssues = z.object({
  total: z.number().int().min(0),
  completed: z.number().int().min(0),
});
export type TrackerSubIssues = z.infer<typeof TrackerSubIssues>;

export const TrackerItem = z.object({
  itemId: z.string().min(1),
  repository: GitHubRepository,
  number: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  url: GitHubIssueUrl,
  assignees: z.array(z.string()).max(20),
  branches: z.array(z.string().min(1).max(255)).max(10),
  pullRequest: TrackerPullRequest.nullable(),
  board: TrackerItemBoard.nullable(),
  parent: TrackerParent.nullable().optional(),
  subIssues: TrackerSubIssues.nullable().optional(),
});
export type TrackerItem = z.infer<typeof TrackerItem>;

export const TrackerSyncResult = z.object({
  login: z.string().min(1),
  items: z.array(TrackerItem).max(200),
  truncated: z.boolean(),
});
export type TrackerSyncResult = z.infer<typeof TrackerSyncResult>;

/**
 * One open issue a tracker follows ("Issue" in the UI). It decorates the branch it is
 * worked on, or waits as not started (coordinator-owned snapshot; GitHub is authoritative).
 */
export const TrackedIssue = z.object({
  /** `${trackerId}:${itemId}` */
  id: Id,
  trackerId: Id,
  itemId: z.string().min(1),
  projectId: Id,
  repository: GitHubRepository,
  number: z.number().int().positive(),
  title: z.string().min(1).max(300),
  url: GitHubIssueUrl,
  assignees: z.array(z.string()).max(20),
  /** Branches GitHub links to the issue. */
  branches: z.array(z.string()).max(10),
  /** The branch Switchyard works on. */
  branch: z.string().nullable(),
  workspaceId: Id.nullable(),
  pullRequest: TrackerPullRequest.nullable(),
  board: TrackerItemBoard.nullable(),
  /** The issue this one is a sub-issue of. */
  parent: TrackerParent.nullable().optional(),
  subIssues: TrackerSubIssues.nullable().optional(),
  updatedAt: Iso,
});
export type TrackedIssue = z.infer<typeof TrackedIssue>;

export const trackedIssueId = (trackerId: string, itemId: string) => `${trackerId}:${itemId}`;

export const OpenIssueRequest = z.object({
  hostId: Id.optional(),
  viewId: z.string().optional(),
  /** The first prompt of a new session. */
  prompt: z.string().optional(),
  profileId: z.string().nullable().optional(),
});
export type OpenIssueRequest = z.infer<typeof OpenIssueRequest>;

export const TrackerSetStatusResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("moved") }),
  z.object({
    status: z.literal("skipped"),
    reason: z.enum(["not_assigned", "shared", "stale"]),
  }),
]);
export type TrackerSetStatusResult = z.infer<typeof TrackerSetStatusResult>;

/** POST /api/issues/:id/link */
export const LinkIssueRequest = z.object({ workspaceId: Id });
export type LinkIssueRequest = z.infer<typeof LinkIssueRequest>;

/** POST /api/issues/:id/status */
export const TrackerStatusRequest = z.object({ status: z.string().min(1).max(200) });

/** Host command bodies (without `type`). */
export const TrackerHostSyncRequest = z.object({
  owner: GitHubLogin,
  repositories: z.array(GitHubRepository).nullable(),
  board: z
    .object({
      projectNumber: z.number().int().positive(),
      statusField: z.string().min(1),
      priorityField: z.string().min(1).nullable().optional(),
    })
    .nullable(),
  follow: TrackerFollow.optional(),
  backlog: z.array(z.string().min(1)).max(20).optional(),
});
export type TrackerHostSyncRequest = z.infer<typeof TrackerHostSyncRequest>;
export const TrackerHostPrepareBranchRequest = z.object({
  checkoutPath: z.string().min(1),
  branch: z.string().min(1).max(255),
});
export const TrackerHostStartIssueRequest = z.object({
  checkoutPath: z.string().min(1),
  repository: GitHubRepository,
  number: z.number().int().positive(),
  branch: z.string().min(1).max(255),
  base: z.string().min(1),
});
export type TrackerHostStartIssueRequest = z.infer<typeof TrackerHostStartIssueRequest>;
export const TrackerHostSetStatusRequest = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1),
  fieldId: z.string().min(1),
  statusField: z.string().min(1),
  optionId: z.string().min(1),
  expectedOptionId: z.string().nullable(),
  login: z.string().min(1),
  allowShared: z.boolean(),
  allowUnassigned: z.boolean().optional(),
});
export type TrackerHostSetStatusRequest = z.infer<typeof TrackerHostSetStatusRequest>;
