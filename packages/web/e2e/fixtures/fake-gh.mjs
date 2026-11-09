#!/usr/bin/env node
/**
 * Hermetic gh executable, installed only on the e2e host's PATH by global-setup.
 * No subprocesses, network, credentials, or real-gh fallback. Unknown argv fails closed.
 * Each canonical cwd has its own <sha256(cwd)>.json scenario; calls are append-only
 * JSONL so parallel viewport tests can assert the actual host-side command boundary.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.SWITCHYARD_E2E_GH_ROOT;
if (!root) throw new Error("fake gh requires SWITCHYARD_E2E_GH_ROOT");
const args = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
appendFileSync(join(root, "calls.jsonl"), `${JSON.stringify({ cwd, args })}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (args.length === 1 && args[0] === "--version") {
  console.log("gh version 2.103.3 (Switchyard isolated e2e fixture)");
} else if (
  JSON.stringify(args) ===
  JSON.stringify(["auth", "status", "--hostname", "github.com", "--active", "--no-refresh"])
) {
  console.log("github.com: isolated fixture, no credentials");
} else {
  const file = join(root, `${createHash("sha256").update(cwd).digest("hex")}.json`);
  let scenario;
  try {
    scenario = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`No fake-gh scenario for ${cwd}`);
  }
  const repository = scenario.repository;
  if (!/^switchyard-e2e\/fixture-[a-z0-9-]+$/.test(repository))
    fail("Unexpected fake-gh repository");
  const url = `https://github.com/${repository}/pull/7`;
  const pr = {
    number: 7,
    url,
    title: scenario.title,
    state: scenario.merged ? "MERGED" : "OPEN",
    isDraft: false,
    headRefName: scenario.branch,
    headRefOid: scenario.head,
    headRepository: { name: repository.split("/")[1] },
    headRepositoryOwner: { login: "switchyard-e2e" },
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
  };
  if (args[0] === "pr" && args[1] === "view") {
    json(pr);
  } else if (args[0] === "pr" && args[1] === "list") {
    json([pr]);
  } else if (args[0] === "pr" && args[1] === "checks") {
    json([
      {
        name: "Isolated CI",
        state: "SUCCESS",
        bucket: "pass",
        link: `https://github.com/${repository}/actions/runs/100/job/201`,
        workflow: "CI",
        event: "pull_request",
        startedAt: "2026-11-01T00:00:00Z",
        completedAt: "2026-11-01T00:01:00Z",
        description: "Fixture passed",
      },
    ]);
  } else if (args[0] === "api" && args.includes("graphql")) {
    if (
      !args.includes("owner=switchyard-e2e") ||
      !args.includes(`name=${repository.split("/")[1]}`)
    )
      fail("Unexpected GraphQL repository");
    json({
      data: {
        repository: {
          squashMergeAllowed: true,
          pullRequest: {
            id: `PR_${repository.replaceAll("/", "_")}_7`,
            state: pr.state,
            headRefOid: scenario.head,
            mergeCommit: scenario.merged ? { oid: "c".repeat(40) } : null,
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
            autoMergeRequest: null,
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "thread-e2e",
                  isResolved: false,
                  isOutdated: false,
                  path: "README.md",
                  line: 1,
                  startLine: null,
                  diffSide: "RIGHT",
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        id: "comment-e2e",
                        author: { login: "fixture-reviewer" },
                        body: "Please clarify the isolated fixture.",
                        url: `${url}#discussion_r1`,
                        createdAt: "2026-11-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
  } else if (
    JSON.stringify(args) ===
    JSON.stringify(["api", "--hostname", "github.com", `repos/${repository}`])
  ) {
    json({ full_name: repository, fork: false });
  } else if (args[0] === "api" && args.includes("PUT")) {
    // Even fake mutations accept only the one SHA-guarded direct squash endpoint.
    const expected = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "PUT",
      `repos/${repository}/pulls/7/merge`,
      "-f",
      `sha=${scenario.head}`,
      "-f",
      "merge_method=squash",
    ];
    if (JSON.stringify(args) !== JSON.stringify(expected))
      fail("HTTP 409: head mismatch or unsafe merge");
    scenario.merged = true;
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(scenario));
    renameSync(`${file}.${process.pid}.tmp`, file);
    json({ merged: true, sha: "c".repeat(40) });
  } else if (
    JSON.stringify(args) ===
    JSON.stringify(["issue", "view", "https://github.com/switchyard-e2e/fixture/issues/17"])
  ) {
    console.log("Isolated issue #17\nRead only; no real GitHub request was made.");
  } else {
    fail(`Unsupported fake-gh command: ${JSON.stringify(args)}`);
  }
}
