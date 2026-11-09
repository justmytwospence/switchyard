import { z } from "zod";

declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const URL: {
  new (
    input: string,
  ): {
    protocol: string;
    username: string;
    password: string;
    hostname: string;
    port: string;
    pathname: string;
    search: string;
    hash: string;
  };
};

const Id = z.string().min(1).max(200);
const Instant = z.string().refine((s) => {
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
});
const positive = z.number().int().safe().positive();
const nonnegative = z.number().int().safe().nonnegative();
const reason = z.string().min(1).max(2000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const actionsId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const bytes = (s: string) => new TextEncoder().encode(s).length;
const displayUrl = z
  .string()
  .max(4096)
  .refine((s) => {
    try {
      const u = new URL(s);
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  });
const githubUrl = displayUrl.refine((s) => {
  try {
    const u = new URL(s);
    return (
      u.protocol === "https:" &&
      u.hostname === "github.com" &&
      !u.port &&
      /^https:\/\/github\.com(?:[/?#]|$)/i.test(s)
    );
  } catch {
    return false;
  }
});
export const GitHubRepository = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/);
const issuePath =
  /^[hH][tT][tT][pP][sS]:\/\/[gG][iI][tT][hH][uU][bB]\.[cC][oO][mM]\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/;
export const GitHubIssueUrl = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const match = issuePath.exec(raw);
    const number = match ? Number(match[3]) : NaN;
    if (
      !match ||
      !GitHubRepository.safeParse(`${match[1]}/${match[2]}`).success ||
      !Number.isSafeInteger(number)
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid GitHub issue URL" });
      return z.NEVER;
    }
    return `https://github.com/${match[1]}/${match[2]}/issues/${number}`;
  });
export type GitHubIssueUrl = z.infer<typeof GitHubIssueUrl>;

function issueParts(url: string): { repository: string; number: number } {
  const match = issuePath.exec(url)!;
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}
function issuePrompt(url: string): string {
  return `${url}\n\nRead it with \`gh issue view ${url}\`.`;
}
export function githubIssueLaunchPrompt(url: string): string {
  return issuePrompt(GitHubIssueUrl.parse(url));
}
export const GitHubIssueIdentity = z
  .object({
    repository: GitHubRepository,
    number: positive,
    url: GitHubIssueUrl,
  })
  .strict()
  .refine((v) => {
    const parts = issueParts(v.url);
    return v.repository === parts.repository && v.number === parts.number;
  });
export type GitHubIssueIdentity = z.infer<typeof GitHubIssueIdentity>;
export const GitHubIssue = z
  .object({
    repository: GitHubRepository,
    number: positive,
    url: GitHubIssueUrl,
    launchPrompt: z.string(),
  })
  .strict()
  .refine((v) => {
    const parts = issueParts(v.url);
    return (
      v.repository === parts.repository &&
      v.number === parts.number &&
      v.launchPrompt === issuePrompt(v.url)
    );
  });
export type GitHubIssue = z.infer<typeof GitHubIssue>;
export function githubIssueFromUrl(raw: string): GitHubIssue {
  const url = GitHubIssueUrl.parse(raw);
  return { ...issueParts(url), url, launchPrompt: issuePrompt(url) };
}

export const GitHubSha = z.string().regex(/^[0-9a-f]{40}$/);
const prUrl = githubUrl.refine((s) => {
  try {
    const u = new URL(s);
    return /^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(u.pathname) && !u.search && !u.hash;
  } catch {
    return false;
  }
});
function matchesPr(url: string, repository: string, number: number): boolean {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase() === `/${repository}/pull/${number}`.toLowerCase();
  } catch {
    return false;
  }
}
export const HostGitHub = z
  .object({ available: z.boolean(), reason: reason.nullable() })
  .strict()
  .refine((v) => v.available === (v.reason === null));
export const GitHubCheck = z
  .object({
    id: hash,
    name: z.string().min(1).max(300),
    state: z.string().min(1).max(100),
    bucket: z.enum(["pass", "fail", "pending", "skipping", "cancel", "unknown"]),
    link: displayUrl.nullable(),
    workflow: z.string().max(300).nullable(),
    event: z.string().max(100).nullable(),
    startedAt: Instant.nullable(),
    completedAt: Instant.nullable(),
    description: z.string().max(2000).nullable(),
    actionsJob: z
      .object({ runId: actionsId, jobId: actionsId, attempt: positive })
      .strict()
      .nullable(),
  })
  .strict();
export const GitHubComment = z
  .object({
    id: Id,
    author: z.string().min(1).max(200).nullable(),
    body: z.string().refine((v) => [...v].length <= 8000),
    bodyTruncated: z.boolean(),
    url: githubUrl,
    createdAt: Instant.nullable(),
  })
  .strict();
export const GitHubThread = z
  .object({
    id: Id,
    isResolved: z.literal(false),
    isOutdated: z.boolean(),
    path: z.string().max(8192).nullable(),
    line: positive.nullable(),
    startLine: positive.nullable(),
    side: z.enum(["LEFT", "RIGHT"]).nullable(),
    comments: z.array(GitHubComment).max(10),
    commentsComplete: z.boolean(),
  })
  .strict();
export const GitHubPullRequest = z
  .object({
    nodeId: z.string().min(1).optional(),
    number: positive,
    url: prUrl,
    title: z.string().min(1).max(1000),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    headRefName: z.string().min(1).max(255),
    headRefOid: GitHubSha,
    headRepository: GitHubRepository.nullable(),
    baseRefName: z.string().min(1).max(255),
    mergeable: z.string().min(1).max(100),
    mergeStateStatus: z.string().min(1).max(100),
    reviewDecision: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]).nullable(),
    mergeQueueEnabled: z.boolean(),
    inMergeQueue: z.boolean(),
    autoMergeEnabled: z.boolean(),
    squashMergeAllowed: z.boolean(),
  })
  .strict()
  .refine((v) => {
    try {
      return new URL(v.url).pathname.endsWith(`/pull/${v.number}`);
    } catch {
      return false;
    }
  });
export const WorkspaceGitHub = z
  .object({
    repository: GitHubRepository.nullable(),
    headRepository: GitHubRepository.nullable(),
    branch: z.string().min(1).max(255).nullable(),
    fetchedAt: Instant.nullable(),
    attemptedAt: Instant,
    status: z.enum(["ready", "unavailable", "error", "ambiguous"]),
    reason: reason.nullable(),
    pullRequest: GitHubPullRequest.nullable(),
    checks: z.array(GitHubCheck).max(500),
    checksComplete: z.boolean(),
    threads: z.array(GitHubThread).max(500),
    threadsComplete: z.boolean(),
    truncated: z.boolean(),
  })
  .strict()
  .refine((v) => {
    if (
      bytes(JSON.stringify(v)) > 512 * 1024 ||
      new Set(v.checks.map((c) => c.id)).size !== v.checks.length
    )
      return false;
    if (
      v.pullRequest &&
      (!v.repository || !matchesPr(v.pullRequest.url, v.repository, v.pullRequest.number))
    )
      return false;
    if (
      v.threads.some((t) => !t.commentsComplete || t.comments.some((c) => c.bodyTruncated)) &&
      (v.threadsComplete || !v.truncated)
    )
      return false;
    if (v.status !== "ready") return v.reason !== null && !v.checksComplete && !v.threadsComplete;
    return (
      v.reason === null &&
      v.fetchedAt !== null &&
      v.repository !== null &&
      v.headRepository !== null &&
      v.branch !== null &&
      (v.pullRequest !== null ||
        (v.checks.length === 0 && v.threads.length === 0 && v.checksComplete && v.threadsComplete))
    );
  });
export const GitHubViewResult = z
  .object({ github: HostGitHub, snapshot: WorkspaceGitHub })
  .strict();
export const GitHubViewResponse = z
  .object({ github: HostGitHub.nullable(), snapshot: WorkspaceGitHub.nullable() })
  .strict();
function lineCount(s: string): number {
  if (!s) return 0;
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
export const GitHubJobLog = z
  .object({
    checkId: hash,
    name: z.string().min(1).max(300),
    url: displayUrl.nullable(),
    runId: actionsId.nullable(),
    jobId: actionsId.nullable(),
    attempt: positive.nullable(),
    status: z.enum([
      "available",
      "unmapped",
      "incomplete",
      "expired",
      "forbidden",
      "timeout",
      "error",
    ]),
    outputTail: z.string().nullable(),
    lineCount: nonnegative.max(150),
    truncated: z.boolean(),
    reason: reason.nullable(),
  })
  .strict()
  .refine((v) =>
    v.status === "available"
      ? v.runId !== null &&
        v.jobId !== null &&
        v.attempt !== null &&
        v.outputTail !== null &&
        bytes(v.outputTail) <= 65536 &&
        lineCount(v.outputTail) === v.lineCount &&
        v.reason === null
      : v.outputTail === null && v.lineCount === 0 && v.reason !== null,
  );
export const GitHubLogs = z
  .object({
    github: HostGitHub,
    repository: GitHubRepository,
    number: positive,
    headOid: GitHubSha,
    fetchedAt: Instant,
    status: z.enum(["ready", "unavailable", "error"]),
    reason: reason.nullable(),
    jobs: z.array(GitHubJobLog).max(10),
    complete: z.boolean(),
    truncated: z.boolean(),
    omittedJobs: nonnegative.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      bytes(JSON.stringify(v)) <= 1024 * 1024 &&
      (v.status === "ready"
        ? v.github.available &&
          v.reason === null &&
          (!v.complete || (v.omittedJobs === 0 && v.jobs.every((j) => j.status === "available")))
        : v.reason !== null && v.jobs.length === 0 && !v.complete),
  );
export const GitHubLogsRequest = z.object({ expectedHeadOid: GitHubSha }).strict();
export const GitHubMergeRequest = z.object({ expectedHeadOid: GitHubSha }).strict();
const mergeFields = {
  github: HostGitHub,
  repository: GitHubRepository,
  number: positive,
  url: prUrl,
  expectedHeadOid: GitHubSha,
};
export const GitHubMergeResult = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("merged"),
        ...mergeFields,
        mergeCommitOid: GitHubSha.nullable(),
        confirmedAt: Instant,
      })
      .strict(),
    z
      .object({
        status: z.literal("outcome_unknown"),
        ...mergeFields,
        reason,
        attemptedAt: Instant,
      })
      .strict(),
  ])
  .refine((v) => matchesPr(v.url, v.repository, v.number));
const path = z.string().min(1).max(8192);
export const GitHubHostViewRequest = z.object({ path }).strict();
export const GitHubHostLogsRequest = z
  .object({ path, repository: GitHubRepository, number: positive, expectedHeadOid: GitHubSha })
  .strict();
export const GitHubHostMergeRequest = GitHubHostLogsRequest.extend({
  expectedPullRequestNodeId: z.string().min(1),
});

export type GitHubRepository = z.infer<typeof GitHubRepository>;
export type GitHubSha = z.infer<typeof GitHubSha>;
export type HostGitHub = z.infer<typeof HostGitHub>;
export type GitHubCheck = z.infer<typeof GitHubCheck>;
export type GitHubComment = z.infer<typeof GitHubComment>;
export type GitHubThread = z.infer<typeof GitHubThread>;
export type GitHubPullRequest = z.infer<typeof GitHubPullRequest>;
export type WorkspaceGitHub = z.infer<typeof WorkspaceGitHub>;
export type GitHubViewResult = z.infer<typeof GitHubViewResult>;
export type GitHubViewResponse = z.infer<typeof GitHubViewResponse>;
export type GitHubJobLog = z.infer<typeof GitHubJobLog>;
export type GitHubLogs = z.infer<typeof GitHubLogs>;
export type GitHubLogsRequest = z.infer<typeof GitHubLogsRequest>;
export type GitHubMergeRequest = z.infer<typeof GitHubMergeRequest>;
export type GitHubMergeResult = z.infer<typeof GitHubMergeResult>;
export type GitHubHostViewRequest = z.infer<typeof GitHubHostViewRequest>;
export type GitHubHostLogsRequest = z.infer<typeof GitHubHostLogsRequest>;
export type GitHubHostMergeRequest = z.infer<typeof GitHubHostMergeRequest>;
