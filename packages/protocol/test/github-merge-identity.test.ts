import { describe, expect, it } from "vitest";
import {
  GitHubHostLogsRequest,
  GitHubHostMergeRequest,
  GitHubLogsRequest,
  GitHubMergeRequest,
  GitHubPullRequest,
} from "../src/github.js";

const sha = "a".repeat(40);
const pr = {
  number: 1,
  url: "https://github.com/base/repo/pull/1",
  title: "PR",
  state: "OPEN",
  isDraft: false,
  headRefName: "branch",
  headRefOid: sha,
  headRepository: "base/repo",
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  mergeQueueEnabled: false,
  inMergeQueue: false,
  autoMergeEnabled: false,
  squashMergeAllowed: true,
};
const hostRequest = {
  path: "/workspace",
  repository: "base/repo",
  number: 1,
  expectedHeadOid: sha,
};

describe("GitHub merge identity", () => {
  it("reads legacy pull requests and validates optional node IDs", () => {
    expect(GitHubPullRequest.safeParse(pr).success).toBe(true);
    expect(GitHubPullRequest.safeParse({ ...pr, nodeId: "PR_node" }).success).toBe(true);
    expect(GitHubPullRequest.safeParse({ ...pr, nodeId: "" }).success).toBe(false);
    expect(GitHubPullRequest.safeParse({ ...pr, nodeId: null }).success).toBe(false);
  });

  it("requires node identity only in host merge requests", () => {
    expect(GitHubHostMergeRequest.safeParse(hostRequest).success).toBe(false);
    expect(
      GitHubHostMergeRequest.safeParse({ ...hostRequest, expectedPullRequestNodeId: "" }).success,
    ).toBe(false);
    expect(
      GitHubHostMergeRequest.safeParse({ ...hostRequest, expectedPullRequestNodeId: "PR_node" })
        .success,
    ).toBe(true);
    expect(GitHubHostLogsRequest.safeParse(hostRequest).success).toBe(true);
    expect(
      GitHubHostLogsRequest.safeParse({ ...hostRequest, expectedPullRequestNodeId: "PR_node" })
        .success,
    ).toBe(false);
    expect(GitHubMergeRequest.safeParse({ expectedHeadOid: sha }).success).toBe(true);
    expect(GitHubLogsRequest.safeParse({ expectedHeadOid: sha }).success).toBe(true);
    expect(
      GitHubMergeRequest.safeParse({ expectedHeadOid: sha, expectedPullRequestNodeId: "PR_node" })
        .success,
    ).toBe(false);
  });
});
