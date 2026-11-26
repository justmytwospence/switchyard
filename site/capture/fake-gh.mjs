#!/usr/bin/env node
/**
 * A hermetic `gh` for the demo stack, installed only on the demo host's PATH. It answers from
 * SWITCHYARD_DEMO_GH (a JSON scenario written by demo-stack.ts): pull requests per branch and the
 * issues a tracker finds. No network, no credentials, no fallback to a real gh.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.SWITCHYARD_DEMO_GH ?? "", "utf8"));
const args = process.argv.slice(2);
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const repoOf = () =>
  /github\.com[/:](.+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prFor = (repository, branch) => {
  const pr = scenario.pullRequests.find((p) => p.repository === repository && p.branch === branch);
  if (!pr) return null;
  const [owner, name] = repository.split("/");
  return {
    number: pr.number,
    url: `https://github.com/${repository}/pull/${pr.number}`,
    title: pr.title,
    state: pr.state,
    isDraft: false,
    headRefName: branch,
    headRefOid: git("rev-parse", "HEAD") || "0".repeat(40),
    headRepository: { name },
    headRepositoryOwner: { login: owner },
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: pr.state === "MERGED" ? "APPROVED" : "REVIEW_REQUIRED",
  };
};
const issueNode = (issue) => ({
  id: `I_${issue.repository}_${issue.number}`,
  number: issue.number,
  title: issue.title,
  url: `https://github.com/${issue.repository}/issues/${issue.number}`,
  state: "OPEN",
  repository: { nameWithOwner: issue.repository },
  assignees: { nodes: [{ login: scenario.login }] },
  linkedBranches: {
    nodes: issue.branch
      ? [{ ref: { name: issue.branch, repository: { nameWithOwner: issue.repository } } }]
      : [],
  },
  closedByPullRequestsReferences: {
    nodes: scenario.pullRequests
      .filter((p) => p.repository === issue.repository && p.issue === issue.number)
      .map((p) => ({
        number: p.number,
        state: p.state,
        url: `https://github.com/${p.repository}/pull/${p.number}`,
        headRefName: p.branch,
        headRepository: { nameWithOwner: p.repository },
      })),
  },
  parent: null,
  subIssuesSummary: { total: 0, completed: 0 },
});

if (args[0] === "--version") {
  console.log("gh version 2.103.3 (Switchyard demo fixture)");
} else if (args[0] === "auth" && args[1] === "status") {
  console.log("github.com: demo fixture, no credentials");
} else if (args[0] === "pr" && args[1] === "view") {
  const repository = flag("--repo")?.replace("github.com/", "") ?? repoOf();
  const number = /^\d+$/.test(args[2] ?? "") ? Number(args[2]) : null;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const pr =
    number !== null
      ? scenario.pullRequests.find((p) => p.repository === repository && p.number === number)
      : null;
  const raw = prFor(repository, pr?.branch ?? branch);
  if (!raw) fail("no pull requests found for branch");
  json(raw);
} else if (args[0] === "pr" && args[1] === "list") {
  const raw = prFor(flag("--repo")?.replace("github.com/", ""), flag("--head"));
  json(raw ? [raw] : []);
} else if (args[0] === "pr" && args[1] === "checks") {
  json([
    {
      name: "test",
      state: "SUCCESS",
      bucket: "pass",
      link: "https://github.com/acme/ci",
      workflow: "CI",
      event: "pull_request",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:03:00Z",
      description: "All checks passed",
    },
  ]);
} else if (args[0] === "api" && args.includes("graphql")) {
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  if (query.includes("search(")) {
    json({
      data: {
        viewer: { login: scenario.login },
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: scenario.issues.map(issueNode),
        },
      },
    });
  } else if (query.includes("reviewThreads")) {
    json({
      data: {
        repository: {
          squashMergeAllowed: true,
          pullRequest: {
            id: "PR_demo",
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
            autoMergeRequest: null,
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    });
  } else {
    json({ data: { repository: { pullRequest: null } } });
  }
} else if (args[0] === "api" && /^repos\/[^/]+\/[^/]+$/.test(args.at(-1) ?? "")) {
  json({ full_name: args.at(-1).slice("repos/".length), fork: false });
} else {
  fail(`demo gh: unsupported command ${JSON.stringify(args)}`);
}
