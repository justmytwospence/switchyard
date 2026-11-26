import { z } from "zod";
import { GitHubIssueUrl, GitHubRepository } from "./github.js";

/**
 * A scope's GitHub source: a user's GitHub issues (assigned to them, or every open issue on a board)
 * in one owner (optionally some repositories, plus repositories of other owners, optionally with a
 * Projects board), synced into tracked issues that link to branches and worktrees. See docs/scopes.md.
 */

const Iso = z.string();
const Id = z.string().min(1);

/** Host feature: the host answers `tracker.*` commands (the wire keeps the old name). */
export const GITHUB_ISSUES_FEATURE = "trackers.v1";
/** Host feature: tracker.sync can follow a board and skip backlog columns. */
export const GITHUB_BOARD_FEATURE = "trackers.board.v1";

/** Which issues a source follows: those assigned to you, or every open issue on its board. */
export const IssueFollow = z.enum(["assigned", "board"]);
export type IssueFollow = z.infer<typeof IssueFollow>;

export const GitHubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const BoardStatusOption = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
});
export type BoardStatusOption = z.infer<typeof BoardStatusOption>;

export const SourceBoard = z.object({
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
export type SourceBoard = z.infer<typeof SourceBoard>;

/** What feeds a scope its issues: a GitHub owner, read with a host's `gh` login. */
export const GitHubSource = z.object({
  kind: z.literal("github"),
  /** The host whose `gh` login reads the issues. */
  hostId: Id,
  owner: GitHubLogin,
  repositories: z.array(GitHubRepository).min(1).max(50).nullable(),
  /** Repositories outside `owner` that belong to this source too (never limited by `repositories`). */
  extraRepositories: z.array(GitHubRepository).max(20).optional(),
  board: SourceBoard.nullable(),
  /** Which issues it follows; absent means "assigned". "board": every open issue on its board. */
  follow: IssueFollow.optional(),
  writeBack: z.boolean(),
  moveShared: z.boolean(),
  /** Make a worktree for an issue branch that has none; absent means true. */
  worktrees: z.boolean().optional(),
  enabled: z.boolean(),
  /** The host's `gh` user, from the last sync. */
  login: z.string().nullable(),
  lastSyncedAt: Iso.nullable(),
  lastError: z.string().max(2000).nullable(),
});
export type GitHubSource = z.infer<typeof GitHubSource>;

/** Stored sources lack the newer fields: always read them through these. */
export const sourceFollow = (t: Pick<GitHubSource, "follow" | "board">): IssueFollow =>
  t.follow === "board" && t.board ? "board" : "assigned";
export const sourceMakesWorktrees = (t: Pick<GitHubSource, "worktrees">): boolean =>
  t.worktrees !== false;
export const sourceBacklog = (t: Pick<GitHubSource, "board">): string[] => t.board?.backlog ?? [];

export const GitHubSourceInput = z.object({
  hostId: Id,
  owner: GitHubLogin,
  repositories: GitHubSource.shape.repositories.default(null),
  extraRepositories: z.array(GitHubRepository).max(20).default([]),
  board: SourceBoard.nullable().default(null),
  follow: IssueFollow.default("assigned"),
  writeBack: z.boolean().default(false),
  moveShared: z.boolean().default(true),
  worktrees: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type GitHubSourceInput = z.input<typeof GitHubSourceInput>;

export const GitHubSourcePatch = z.object({
  hostId: Id.optional(),
  owner: GitHubLogin.optional(),
  repositories: GitHubSource.shape.repositories.optional(),
  extraRepositories: z.array(GitHubRepository).max(20).optional(),
  board: SourceBoard.nullable().optional(),
  follow: IssueFollow.optional(),
  writeBack: z.boolean().optional(),
  moveShared: z.boolean().optional(),
  worktrees: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type GitHubSourcePatch = z.input<typeof GitHubSourcePatch>;

export const IssueBoard = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1),
  fieldId: z.string().min(1),
  status: z.string().nullable(),
  statusOptionId: z.string().nullable(),
  options: z.array(BoardStatusOption).max(50),
  /** The issue's value of the source's priority field; `rank` is its option's position. */
  priority: z
    .object({ name: z.string().min(1).max(200), rank: z.number().int().min(0) })
    .nullable()
    .optional(),
});
export type IssueBoard = z.infer<typeof IssueBoard>;

export const IssuePullRequest = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string().url(),
  headRefName: z.string().min(1).max(255),
});
export type IssuePullRequest = z.infer<typeof IssuePullRequest>;

export const IssueParent = z.object({
  number: z.number().int().positive(),
  title: z.string().max(300),
  url: GitHubIssueUrl,
});
export type IssueParent = z.infer<typeof IssueParent>;

export const IssueSubIssues = z.object({
  total: z.number().int().min(0),
  completed: z.number().int().min(0),
});
export type IssueSubIssues = z.infer<typeof IssueSubIssues>;

export const SyncedIssue = z.object({
  itemId: z.string().min(1),
  repository: GitHubRepository,
  number: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  url: GitHubIssueUrl,
  assignees: z.array(z.string()).max(20),
  branches: z.array(z.string().min(1).max(255)).max(10),
  pullRequest: IssuePullRequest.nullable(),
  board: IssueBoard.nullable(),
  parent: IssueParent.nullable().optional(),
  subIssues: IssueSubIssues.nullable().optional(),
});
export type SyncedIssue = z.infer<typeof SyncedIssue>;

export const IssueSyncResult = z.object({
  login: z.string().min(1),
  items: z.array(SyncedIssue).max(200),
  truncated: z.boolean(),
});
export type IssueSyncResult = z.infer<typeof IssueSyncResult>;

/**
 * One open issue a scope's source follows ("Issue" in the UI). It decorates the branch it is
 * worked on, or waits as not started (coordinator-owned snapshot; GitHub is authoritative).
 */
export const TrackedIssue = z.object({
  /** `${scopeId}:${itemId}` */
  id: Id,
  scopeId: Id,
  /** COMPAT(scopes-rename): remove after 2027-03-01. A copy of scopeId for 0.20 clients. */
  trackerId: Id.optional(),
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
  pullRequest: IssuePullRequest.nullable(),
  board: IssueBoard.nullable(),
  /** The issue this one is a sub-issue of. */
  parent: IssueParent.nullable().optional(),
  subIssues: IssueSubIssues.nullable().optional(),
  updatedAt: Iso,
});
export type TrackedIssue = z.infer<typeof TrackedIssue>;

export const trackedIssueId = (scopeId: string, itemId: string) => `${scopeId}:${itemId}`;

export const OpenIssueRequest = z.object({
  hostId: Id.optional(),
  scopeId: z.string().optional(),
  /** COMPAT(scopes-rename): remove after 2027-03-01. The old name of scopeId. */
  viewId: z.string().optional(),
  /** The first prompt of a new session. */
  prompt: z.string().optional(),
  profileId: z.string().nullable().optional(),
});
export type OpenIssueRequest = z.infer<typeof OpenIssueRequest>;

export const IssueSetStatusResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("moved") }),
  z.object({
    status: z.literal("skipped"),
    reason: z.enum(["not_assigned", "shared", "stale"]),
  }),
]);
export type IssueSetStatusResult = z.infer<typeof IssueSetStatusResult>;

/** POST /api/issues/:id/link */
export const LinkIssueRequest = z.object({ workspaceId: Id });
export type LinkIssueRequest = z.infer<typeof LinkIssueRequest>;

/** POST /api/issues/:id/status */
export const IssueStatusRequest = z.object({ status: z.string().min(1).max(200) });

/** Host command bodies (without `type`). */
export const IssueHostSyncRequest = z.object({
  owner: GitHubLogin,
  repositories: z.array(GitHubRepository).nullable(),
  board: z
    .object({
      projectNumber: z.number().int().positive(),
      statusField: z.string().min(1),
      priorityField: z.string().min(1).nullable().optional(),
    })
    .nullable(),
  follow: IssueFollow.optional(),
  backlog: z.array(z.string().min(1)).max(20).optional(),
});
export type IssueHostSyncRequest = z.infer<typeof IssueHostSyncRequest>;
export const IssueHostPrepareBranchRequest = z.object({
  checkoutPath: z.string().min(1),
  branch: z.string().min(1).max(255),
});
export const IssueHostStartIssueRequest = z.object({
  checkoutPath: z.string().min(1),
  repository: GitHubRepository,
  number: z.number().int().positive(),
  branch: z.string().min(1).max(255),
  base: z.string().min(1),
});
export type IssueHostStartIssueRequest = z.infer<typeof IssueHostStartIssueRequest>;
export const IssueHostSetStatusRequest = z.object({
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
export type IssueHostSetStatusRequest = z.infer<typeof IssueHostSetStatusRequest>;
