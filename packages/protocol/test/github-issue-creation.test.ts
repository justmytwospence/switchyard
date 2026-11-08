import { describe, expect, it } from "vitest";
import { CreateTaskRequest, UpdateTaskRequest } from "../src/api.js";
import { Task } from "../src/entities.js";
import {
  GitHubComment,
  GitHubIssue,
  GitHubIssueIdentity,
  GitHubIssueUrl,
  GitHubMergeResult,
  GitHubPullRequest,
  githubIssueFromUrl,
  githubIssueLaunchPrompt,
  WorkspaceGitHub,
} from "../src/github.js";

const url = "https://github.com/Owner/Repo/issues/17";
const issue = githubIssueFromUrl(url);
const create = { projectId: "p", githubIssueUrl: url };

describe("issue URLs and frozen metadata", () => {
  it("canonicalizes only scheme and host and preserves path spelling", () => {
    expect(GitHubIssueUrl.parse("  HTTPS://GitHub.COM/Owner/Repo/issues/17  ")).toBe(url);
    expect(GitHubIssueUrl.parse("https://github.com/a/r/issues/9007199254740991")).toContain(
      "9007199254740991",
    );
    expect(issue).toEqual({
      repository: "Owner/Repo",
      number: 17,
      url,
      launchPrompt: `${url}\n\nRead it with \`gh issue view ${url}\`.`,
    });
    expect(githubIssueLaunchPrompt(` ${url} `)).toBe(issue.launchPrompt);
    expect(issue.launchPrompt.endsWith("\n")).toBe(false);
  });
  it.each([
    "",
    " ",
    "http://github.com/Owner/Repo/issues/17",
    "https://www.github.com/Owner/Repo/issues/17",
    "https://user@github.com/Owner/Repo/issues/17",
    "https://github.com:443/Owner/Repo/issues/17",
    "https://github.com:444/Owner/Repo/issues/17",
    `${url}?x=1`,
    `${url}#x`,
    `${url}/`,
    `${url}/x`,
    "https://github.com/Owner/Repo/pull/17",
    "https://github.com/Owner/Repo/ISSUES/17",
    "https://github.com/Owner/Repo/issues/0",
    "https://github.com/Owner/Repo/issues/01",
    "https://github.com/Owner/Repo/issues/9007199254740992",
    "https://github.com/Owner/%52epo/issues/17",
    "https://github.com/Owner/../Repo/issues/17",
    "https://github.com/Owner/./issues/17",
    "https://github.com/-Owner/Repo/issues/17",
    `https://github.com/Owner/${"a".repeat(101)}/issues/17`,
  ])("rejects %s", (value) => expect(GitHubIssueUrl.safeParse(value).success).toBe(false));
  it("checks every identity field and frozen prompt", () => {
    expect(GitHubIssueIdentity.safeParse(issue).success).toBe(false); // no extra metadata
    const { launchPrompt, ...identity } = issue;
    expect(GitHubIssueIdentity.parse(identity)).toEqual(identity);
    expect(GitHubIssue.parse(issue)).toEqual(issue);
    for (const change of [
      { repository: "owner/Repo" },
      { number: 18 },
      { url: url.replace("17", "18") },
      { launchPrompt: `${launchPrompt}\n` },
      { launchPrompt: null },
    ]) {
      expect(GitHubIssue.safeParse({ ...issue, ...change }).success).toBe(false);
    }
    expect(Task.shape.githubIssue.safeParse(undefined).success).toBe(true);
    expect(Task.shape.githubIssue.safeParse(null).success).toBe(false);
    expect(Task.shape.githubIssue.safeParse(issue).success).toBe(true);
    expect(Task.shape.githubIssue.safeParse({ ...issue, launchPrompt: "other" }).success).toBe(
      false,
    );
  });
});

describe("task creation and patch", () => {
  it("preserves ordinary title and defaults, requiring a title", () => {
    expect(CreateTaskRequest.safeParse({ projectId: "p" }).success).toBe(false);
    expect(CreateTaskRequest.safeParse({ projectId: "p", title: "" }).success).toBe(false);
    expect(CreateTaskRequest.parse({ projectId: "p", title: "  " })).toMatchObject({
      title: "  ",
      objective: "",
      acceptanceCriteria: [],
      dependencies: [],
      priority: 2,
      state: "backlog",
    });
  });
  it("derives or trims issue titles, respecting input length", () => {
    for (const title of [undefined, "", "  "])
      expect(CreateTaskRequest.parse({ ...create, title }).title).toBe("Owner/Repo #17");
    expect(
      CreateTaskRequest.parse({
        ...create,
        title: "  My task  ",
        githubIssueUrl: ` HTTPS://GitHub.COM/Owner/Repo/issues/17 `,
      }),
    ).toMatchObject({ title: "My task", githubIssueUrl: url });
    expect(CreateTaskRequest.safeParse({ ...create, title: " ".repeat(301) }).success).toBe(false);
    expect(CreateTaskRequest.safeParse({ ...create, title: "x".repeat(300) }).success).toBe(true);
    for (const githubIssueUrl of [null, "", "  "])
      expect(CreateTaskRequest.safeParse({ ...create, githubIssueUrl }).success).toBe(false);
    expect(
      CreateTaskRequest.safeParse({
        ...create,
        objective: " \n",
        acceptanceCriteria: [],
        policy: {
          hostId: "h",
          workspace: { mode: "existing", workspaceId: "w" },
          completion: { checks: ["test"], requireHumanReview: true },
          continuation: { enabled: false },
        },
      }).success,
    ).toBe(true);
  });
  it("returns field errors for conflicting import options", () => {
    const result = CreateTaskRequest.safeParse({
      ...create,
      objective: "x",
      acceptanceCriteria: ["x"],
      policy: { continuation: { enabled: true }, completion: { requireHumanReview: false } },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected errors");
    expect(result.error.issues.map((x) => [x.path.join("."), x.message])).toEqual([
      [
        "objective",
        "Issue imports use the issue as their initial objective; leave Objective empty.",
      ],
      [
        "acceptanceCriteria",
        "Issue imports read acceptance from the issue; leave acceptance criteria empty at creation.",
      ],
      ["policy.continuation.enabled", "Issue imports start with continuation disabled."],
      ["policy.completion.requireHumanReview", "Issue imports require human review when created."],
    ]);
  });
  it("rejects known forbidden fields without changing unknown-key behavior", () => {
    for (const field of ["githubIssue", "launchPrompt"])
      expect(CreateTaskRequest.safeParse({ ...create, [field]: "x" }).success).toBe(false);
    for (const field of ["githubIssueUrl", "githubIssue", "launchPrompt"])
      expect(UpdateTaskRequest.safeParse({ [field]: "x" }).success).toBe(false);
    expect(CreateTaskRequest.parse({ ...create, unrelated: true })).not.toHaveProperty("unrelated");
    expect(UpdateTaskRequest.parse({ unrelated: true })).toEqual({});
  });
});

describe("GitHub URL refinement safety", () => {
  const pr = {
    number: 1,
    url: "https://github.com/a/b/pull/1",
    title: "PR",
    state: "OPEN",
    isDraft: false,
    headRefName: "x",
    headRefOid: "a".repeat(40),
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
  const comment = {
    id: "1",
    author: null,
    body: "",
    bodyTruncated: false,
    url: "https://github.com/a/b/issues/1",
    createdAt: null,
  };
  it.each(["not a URL", "https://github.com:443/a/b/pull/1", "https://github.com:444/a/b/pull/1"])(
    "safely rejects PR URL %s through nested refinements",
    (bad) => {
      expect(GitHubPullRequest.safeParse({ ...pr, url: bad }).success).toBe(false);
      expect(
        GitHubMergeResult.safeParse({
          status: "merged",
          github: { available: true, reason: null },
          repository: "a/b",
          number: 1,
          url: bad,
          expectedHeadOid: "a".repeat(40),
          mergeCommitOid: null,
          confirmedAt: "2026-01-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
      expect(
        WorkspaceGitHub.safeParse({
          repository: "a/b",
          headRepository: "a/b",
          branch: "x",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          attemptedAt: "2026-01-01T00:00:00.000Z",
          status: "ready",
          reason: null,
          pullRequest: { ...pr, url: bad },
          checks: [],
          checksComplete: true,
          threads: [],
          threadsComplete: true,
          truncated: false,
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "not a URL",
    "https://github.com:443/a/b/issues/1",
    "https://github.com:444/a/b/issues/1",
  ])("safely rejects comment URL %s", (bad) => {
    expect(GitHubComment.safeParse({ ...comment, url: bad }).success).toBe(false);
  });
});
