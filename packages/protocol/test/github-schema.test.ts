import { describe, expect, it } from "vitest";
import {
  GitHubHostLogsRequest,
  GitHubLogs,
  GitHubMergeResult,
  GitHubThread,
  WorkspaceGitHub,
} from "../src/github.js";

const now = "2026-01-01T00:00:00.000Z";
const sha = "a".repeat(40);
const github = { available: true, reason: null };
const pr = {
  number: 1,
  url: "https://github.com/base/repo/pull/1",
  title: "PR",
  state: "OPEN",
  isDraft: false,
  headRefName: "branch",
  headRefOid: sha,
  headRepository: null,
  baseRefName: "main",
  mergeable: "UNKNOWN",
  mergeStateStatus: "BLOCKED",
  reviewDecision: null,
  mergeQueueEnabled: false,
  inMergeQueue: false,
  autoMergeEnabled: false,
  squashMergeAllowed: true,
};
const snapshot = {
  repository: "base/repo",
  headRepository: "fork/repo",
  branch: "branch",
  fetchedAt: now,
  attemptedAt: now,
  status: "ready",
  reason: null,
  pullRequest: pr,
  checks: [],
  checksComplete: true,
  threads: [],
  threadsComplete: true,
  truncated: false,
};
describe("GitHub schemas", () => {
  it("supports distinct repositories, deleted forks and partial threads", () => {
    expect(WorkspaceGitHub.safeParse(snapshot).success).toBe(true);
    expect(WorkspaceGitHub.safeParse({ ...snapshot, repository: "other/repo" }).success).toBe(
      false,
    );
    expect(
      WorkspaceGitHub.safeParse({
        ...snapshot,
        status: "error",
        reason: "failed",
        checksComplete: false,
        threadsComplete: false,
      }).success,
    ).toBe(true);
    const thread = {
      id: "t",
      isResolved: false,
      isOutdated: true,
      path: null,
      line: null,
      startLine: null,
      side: null,
      comments: [],
      commentsComplete: false,
    };
    expect(GitHubThread.safeParse(thread).success).toBe(true);
    expect(
      WorkspaceGitHub.safeParse({
        ...snapshot,
        threads: [thread],
        threadsComplete: false,
        truncated: true,
      }).success,
    ).toBe(true);
    expect(WorkspaceGitHub.safeParse({ ...snapshot, status: "mystery" }).success).toBe(false);
  });
  it("distinguishes log coverage and merge outcomes", () => {
    const job = {
      checkId: "b".repeat(64),
      name: "test",
      url: null,
      runId: "1",
      jobId: "2",
      attempt: 1,
      status: "available",
      outputTail: "hello\n",
      lineCount: 1,
      truncated: true,
      reason: null,
    };
    const logs = {
      github,
      repository: "base/repo",
      number: 1,
      headOid: sha,
      fetchedAt: now,
      status: "ready",
      reason: null,
      jobs: [job],
      complete: true,
      truncated: true,
      omittedJobs: 0,
    };
    expect(GitHubLogs.safeParse(logs).success).toBe(true);
    expect(GitHubLogs.safeParse({ ...logs, jobs: [{ ...job, lineCount: 2 }] }).success).toBe(false);
    expect(GitHubLogs.safeParse({ ...logs, omittedJobs: null }).success).toBe(false);
    const base = { github, repository: "base/repo", number: 1, url: pr.url, expectedHeadOid: sha };
    expect(
      GitHubMergeResult.safeParse({
        ...base,
        status: "merged",
        mergeCommitOid: null,
        confirmedAt: now,
      }).success,
    ).toBe(true);
    expect(
      GitHubMergeResult.safeParse({
        ...base,
        status: "outcome_unknown",
        reason: "timeout",
        attemptedAt: now,
      }).success,
    ).toBe(true);
    expect(
      GitHubHostLogsRequest.safeParse({
        path: "/tmp",
        repository: "base/repo",
        number: 1,
        expectedHeadOid: sha,
        strategy: "squash",
      }).success,
    ).toBe(false);
  });
});
