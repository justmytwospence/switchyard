import { z } from "zod";
import { GitHubIssueUrl, GitHubRepository } from "./github.js";

/**
 * Trackers: a user's assigned GitHub issues in one owner (optionally some repositories, plus
 * repositories of other owners, optionally with a Projects board), synced into Backlog tasks and worktrees. See docs/trackers.md.
 */

const Iso = z.string();
const Id = z.string().min(1);

/** Host feature: the host answers `tracker.*` commands. */
export const TRACKERS_FEATURE = "trackers.v1";

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
  writeBack: z.boolean(),
  moveShared: z.boolean(),
  enabled: z.boolean(),
  /** The host's `gh` user, from the last sync. */
  login: z.string().nullable(),
  lastSyncedAt: Iso.nullable(),
  lastError: z.string().max(2000).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Tracker = z.infer<typeof Tracker>;

export const TrackerInput = z.object({
  name: Tracker.shape.name,
  hostId: Id,
  owner: GitHubLogin,
  repositories: Tracker.shape.repositories.default(null),
  extraRepositories: z.array(GitHubRepository).max(20).default([]),
  board: TrackerBoard.nullable().default(null),
  writeBack: z.boolean().default(false),
  moveShared: z.boolean().default(true),
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
  writeBack: z.boolean().optional(),
  moveShared: z.boolean().optional(),
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
});
export type TrackerItemBoard = z.infer<typeof TrackerItemBoard>;

export const TrackerPullRequest = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string().url(),
  headRefName: z.string().min(1).max(255),
});
export type TrackerPullRequest = z.infer<typeof TrackerPullRequest>;

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
});
export type TrackerItem = z.infer<typeof TrackerItem>;

export const TrackerSyncResult = z.object({
  login: z.string().min(1),
  items: z.array(TrackerItem).max(200),
  truncated: z.boolean(),
});
export type TrackerSyncResult = z.infer<typeof TrackerSyncResult>;

/** A task's link to its tracker item (server-owned). */
export const TaskTracker = z.object({
  trackerId: Id,
  itemId: z.string().min(1),
  repository: GitHubRepository,
  number: z.number().int().positive(),
  assignees: z.array(z.string()).max(20),
  branch: z.string().nullable(),
  workspaceId: Id.nullable(),
  pullRequest: TrackerPullRequest.nullable(),
  board: TrackerItemBoard.nullable(),
});
export type TaskTracker = z.infer<typeof TaskTracker>;

export const TrackerSetStatusResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("moved") }),
  z.object({
    status: z.literal("skipped"),
    reason: z.enum(["not_assigned", "shared", "stale"]),
  }),
]);
export type TrackerSetStatusResult = z.infer<typeof TrackerSetStatusResult>;

/** POST /api/tasks/:id/tracker/status */
export const TrackerStatusRequest = z.object({ status: z.string().min(1).max(200) });

/** Host command bodies (without `type`). */
export const TrackerHostSyncRequest = z.object({
  owner: GitHubLogin,
  repositories: z.array(GitHubRepository).nullable(),
  board: z
    .object({ projectNumber: z.number().int().positive(), statusField: z.string().min(1) })
    .nullable(),
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
});
export type TrackerHostSetStatusRequest = z.infer<typeof TrackerHostSetStatusRequest>;
