import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubLogs, GitHubMergeResult, GitHubViewResult } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GitHubProcessOptions,
  type GitHubProcessResult,
  type GitHubRunner,
  GitHubService,
} from "../src/github.js";
import { tempDir } from "./helpers.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const NODE_ID = "PR_node_12";
const result = (value: unknown, code = 0): GitHubProcessResult => ({
  code,
  stdout: JSON.stringify(value),
  stderr: "",
});
const pr = () => ({
  number: 12,
  url: "https://github.com/owner/repo/pull/12",
  title: "Change",
  state: "OPEN",
  isDraft: false,
  headRefName: "topic",
  headRefOid: SHA,
  headRepository: { name: "repo" },
  headRepositoryOwner: { login: "owner" },
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
});
const check = (i = 1) => ({
  name: `test ${i}`,
  state: "FAILURE",
  bucket: "fail",
  link: `https://github.com/owner/repo/actions/runs/100/job/${200 + i}`,
  workflow: "CI",
  event: "pull_request",
  startedAt: "2026-11-01T00:00:00Z",
  completedAt: "2026-11-01T00:01:00Z",
  description: "failed",
});
const comment = () => ({
  id: "comment",
  author: { login: "reviewer" },
  body: "Feedback",
  url: "https://github.com/owner/repo/pull/12#discussion_r1",
  createdAt: "2026-11-01T00:00:00Z",
});
const thread = (id = "thread") => ({
  id,
  isResolved: false,
  isOutdated: true,
  path: "file.ts",
  line: 1,
  startLine: null,
  diffSide: "RIGHT",
  comments: { pageInfo: { hasNextPage: false }, nodes: [comment()] },
});
interface Call {
  file: string;
  args: string[];
  options: GitHubProcessOptions;
}
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

function fixture() {
  const dir = tempDir();
  const f = {
    path: dir.path,
    calls: [] as Call[],
    branch: "topic",
    remotes: { origin: "git@github.com:owner/repo.git" } as Record<string, string>,
    config: {} as Record<string, string>,
    parents: {} as Record<string, string>,
    rawPr: pr() as any,
    lists: [] as any[],
    checks: [] as any[],
    checkExit: 0,
    nodeId: NODE_ID,
    settings: {
      squashMergeAllowed: true,
      isMergeQueueEnabled: false,
      isInMergeQueue: false,
      autoMergeRequest: null,
    } as any,
    pages: [{ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }] as any[],
    auth: true,
    mergeResponse: result({ merged: true, sha: OTHER }),
    reconciled: { id: NODE_ID, state: "OPEN", headRefOid: SHA, mergeCommit: null } as any,
    logs: "start\nfailed\ncleanup\n",
    run: {
      id: 100,
      head_sha: SHA,
      run_attempt: 1,
      repository: { full_name: "owner/repo" },
      status: "completed",
    } as any,
    job: { id: 201, run_id: 100, run_attempt: 1, name: "test 1", status: "completed" } as any,
    jobPages: [{ jobs: [] }] as any[],
    checkRun: {
      id: 999,
      head_sha: SHA,
      details_url: "https://github.com/owner/repo/actions/runs/100/job/201",
    } as any,
    intercept: undefined as
      | ((call: Call) => GitHubProcessResult | undefined | Promise<GitHubProcessResult | undefined>)
      | undefined,
    published: [] as any[],
    meta: new Map<string, string>(),
    service: null! as GitHubService,
    make: null! as () => GitHubService,
  };
  const runner: GitHubRunner = async (file, args, options) => {
    const call = { file, args, options };
    f.calls.push(call);
    const override = await f.intercept?.(call);
    if (override) return override;
    if (file === "git") {
      const value =
        args[0] === "rev-parse"
          ? f.path
          : args[0] === "symbolic-ref"
            ? f.branch
            : args[0] === "config"
              ? (f.config[args[2]!] ?? "")
              : (f.remotes[args.at(-1)!] ?? "");
      return { code: value ? 0 : 1, stdout: value, stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: "gh 2.103.3", stderr: "" };
    if (args[0] === "auth")
      return { code: f.auth ? 0 : 1, stdout: "", stderr: f.auth ? "" : "Not signed in" };
    if (args[0] === "pr" && args[1] === "view")
      return f.rawPr
        ? result(f.rawPr)
        : { code: 1, stdout: "", stderr: "no pull requests found for branch topic" };
    if (args[0] === "pr" && args[1] === "list") {
      const selector = args[args.indexOf("--head") + 1];
      if (selector !== f.branch || selector.includes(":"))
        return { code: 1, stdout: "", stderr: "invalid head selector" };
      return result(f.lists);
    }
    if (args[0] === "pr" && args[1] === "checks") return result(f.checks, f.checkExit);
    if (args.includes("graphql")) {
      if (args.some((a) => a.includes("mergeCommit{oid}")))
        return result({ data: { repository: { pullRequest: f.reconciled } } });
      const cursor = args.find((a) => a.startsWith("cursor="));
      const page = cursor ? Number(cursor.slice(7)) : 0;
      return result({
        data: {
          repository: {
            squashMergeAllowed: f.settings.squashMergeAllowed,
            pullRequest: { id: f.nodeId, ...f.settings, reviewThreads: f.pages[page] },
          },
        },
      });
    }
    if (args.includes("PUT")) return f.mergeResponse;
    const endpoint = args.at(-1)!;
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      const repository = endpoint.slice(6);
      const parent = f.parents[repository];
      return result({
        full_name: repository,
        fork: !!parent,
        parent: parent ? { full_name: parent } : null,
      });
    }
    if (/\/check-runs\//.test(endpoint)) return result(f.checkRun);
    if (/\/actions\/jobs\//.test(endpoint))
      return result({ ...f.job, id: Number(endpoint.split("/").at(-1)) });
    if (/\/attempts\/.*\/jobs\?/.test(endpoint))
      return result(f.jobPages[Number(/page=(\d+)$/.exec(endpoint)![1]) - 1]);
    if (/\/actions\/runs\//.test(endpoint)) return result(f.run);
    if (args[0] === "run") return { code: 0, stdout: f.logs, stderr: "" };
    throw new Error(`Unexpected command ${file} ${args.join(" ")}`);
  };
  f.make = () => {
    const service = new GitHubService({
      runner,
      db: {
        getMeta: (key) => f.meta.get(key) ?? null,
        setMeta: (key, value) => {
          f.meta.set(key, value);
        },
      },
      publish: (path, snapshot) => f.published.push({ path, snapshot }),
      env: { GH_TOKEN: "host-credential", GH_HOST: "enterprise.invalid" },
    });
    cleanup.push(() => service.stop());
    return service;
  };
  cleanup.push(() => dir.cleanup());
  f.service = f.make();
  return f;
}
const input = (f: ReturnType<typeof fixture>) => ({
  path: f.path,
  repository: "owner/repo",
  number: 12,
  expectedHeadOid: SHA,
});
const mergeInput = (f: ReturnType<typeof fixture>) => ({
  ...input(f),
  expectedPullRequestNodeId: NODE_ID,
});
const puts = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.args.includes("PUT"));
const logCalls = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.args[0] === "run");

describe("GitHub probe and process boundaries", () => {
  it("probes independently, preserves credentials and forces public noninteractive gh", async () => {
    const f = fixture();
    expect(await f.service.probe()).toEqual({ available: true, reason: null });
    expect(f.calls.map((c) => c.args)).toEqual([
      ["--version"],
      ["auth", "status", "--hostname", "github.com", "--active", "--no-refresh"],
    ]);
    for (const c of f.calls) {
      expect(c.options.timeoutMs).toBeGreaterThan(0);
      expect(c.options.timeoutMs).toBeLessThanOrEqual(5000);
      expect(c.options.env).toMatchObject({
        GH_HOST: "github.com",
        GH_TOKEN: "host-credential",
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(c.args).not.toContain("--show-token");
    }
  });
  it.each(["missing", "signed-out", "timeout"])(
    "does not break the host when gh is %s",
    async (mode) => {
      const f = fixture();
      f.intercept = ({ args }) =>
        args[0] === "--version"
          ? {
              code: null,
              stdout: "",
              stderr: mode === "missing" ? "spawn gh ENOENT" : "failed",
              timedOut: mode === "timeout",
            }
          : undefined;
      expect((await f.service.refresh(f.path)).snapshot.status).toBe("unavailable");
      expect(f.service.github.available).toBe(false);
    },
  );
  it("repository 403 does not revoke host-wide authentication and stderr is sanitized", async () => {
    const f = fixture();
    f.intercept = ({ args }) =>
      args[0] === "pr"
        ? {
            code: 1,
            stdout: "",
            stderr: `\u001b[31mHTTP 403 Bearer secret\u0000 ${"x".repeat(9000)}`,
          }
        : undefined;
    const r = await f.service.refresh(f.path);
    expect(r.github.available).toBe(true);
    expect(r.snapshot.status).toBe("error");
    expect(r.snapshot.reason).not.toContain("secret");
    expect(r.snapshot.reason!.length).toBeLessThanOrEqual(2000);
  });
  it("enforces JSON output and aggregate refresh deadlines", async () => {
    const f = fixture();
    f.intercept = ({ args }) =>
      args[0] === "pr"
        ? { code: 0, stdout: " ".repeat(2 * 1024 * 1024 + 1), stderr: "" }
        : undefined;
    expect((await f.service.refresh(f.path)).snapshot.reason).toContain("2 MiB");
    f.intercept = undefined;
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    f.intercept = () => {
      now += 5000;
      return undefined;
    };
    const r = await f.service.refresh(f.path);
    expect(r.snapshot.status).not.toBe("ready");
    expect(f.calls.every((c) => c.options.timeoutMs <= 20000)).toBe(true);
  });
  it("uses the actual private argv runner, bounded output and no shell interpolation", async () => {
    const dir = tempDir();
    cleanup.push(() => dir.cleanup());
    const gh = join(dir.path, "gh");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s' "$1"\n`);
    chmodSync(gh, 0o755);
    const service = new GitHubService({ env: { PATH: `${dir.path}:${process.env.PATH}` } });
    cleanup.push(() => service.stop());
    expect(await service.probe()).toEqual({ available: true, reason: null });
    writeFileSync(gh, `#!/bin/sh\nprintf 'ghp_shouldnotleak\\033[31m' >&2\nexit 1\n`);
    expect((await service.probe()).reason).not.toContain("ghp_shouldnotleak");
  });
});

describe("verified workspace PR snapshots", () => {
  it("returns a typed unavailable snapshot for a removed workspace", async () => {
    const f = fixture();
    expect(await f.service.refresh(join(f.path, "removed"))).toMatchObject({
      github: { available: true },
      snapshot: { status: "unavailable", pullRequest: null, fetchedAt: null },
    });
  });
  it("gives each concurrent explicit refresh its own fresh read", async () => {
    const f = fixture();
    const requests = Array.from({ length: 3 }, () => f.service.refresh(f.path));
    const results = await Promise.all(requests);
    expect(results.every((r) => r.snapshot.status === "ready")).toBe(true);
    expect(f.calls.filter((c) => c.args[0] === "pr" && c.args[1] === "view")).toHaveLength(3);
    expect(f.published).toHaveLength(3);
  });
  it("reapplies the serialized size bound when a near-limit snapshot becomes stale", async () => {
    const f = fixture();
    f.checks = Array.from({ length: 500 }, (_, i) => ({
      ...check(i),
      description: "x".repeat(1600),
    }));
    const fresh = await f.service.refresh(f.path);
    expect(fresh.snapshot.status).toBe("ready");
    f.intercept = ({ args }) =>
      args[0] === "pr" ? { code: 1, stdout: "", stderr: "x".repeat(2000) } : undefined;
    const stale = await f.service.refresh(f.path);
    expect(stale.snapshot).toMatchObject({ status: "error", pullRequest: { number: 12 } });
    expect(Buffer.byteLength(JSON.stringify(stale.snapshot))).toBeLessThanOrEqual(512 * 1024);
  });
  it("preserves stale association display on host sign-out only for the same head identity", async () => {
    const f = fixture();
    await f.service.refresh(f.path);
    f.auth = false;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "unavailable",
      pullRequest: { number: 12 },
      checksComplete: false,
      threadsComplete: false,
    });
    f.branch = "different";
    expect((await f.service.refresh(f.path)).snapshot.pullRequest).toBeNull();
  });
  it("normalizes complete data and emits a partial durable workspace update", async () => {
    const f = fixture();
    f.checks = [{ ...check(), bucket: "pass", link: "javascript:alert(1)" }];
    f.pages[0].nodes = [thread(), { ...thread("resolved"), isResolved: true }];
    const r = await f.service.refresh(f.path);
    expect(GitHubViewResult.safeParse(r).success).toBe(true);
    expect(r.snapshot).toMatchObject({
      status: "ready",
      repository: "owner/repo",
      headRepository: "owner/repo",
      branch: "topic",
      checksComplete: true,
      threadsComplete: true,
    });
    expect(r.snapshot.checks[0]).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      link: null,
      startedAt: "2026-11-01T00:00:00.000Z",
      actionsJob: null,
    });
    expect(r.snapshot.threads).toHaveLength(1);
    expect(r.snapshot.threads[0]).toMatchObject({ isOutdated: true, commentsComplete: true });
    expect(f.published).toEqual([{ path: f.path, snapshot: r.snapshot }]);
  });
  it("returns confirmed no PR separately from network/auth errors", async () => {
    const f = fixture();
    f.rawPr = null;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "ready",
      pullRequest: null,
      checks: [],
      threads: [],
      checksComplete: true,
      threadsComplete: true,
    });
    f.intercept = ({ args }) =>
      args[0] === "pr" ? { code: 1, stdout: "", stderr: "network unavailable" } : undefined;
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("error");
  });
  it("discovers a public fork parent even when origin is the fork and gh pr view finds no PR there", async () => {
    const f = fixture();
    f.remotes.origin = "git@github.com:fork/repo.git";
    f.parents["fork/repo"] = "owner/repo";
    f.rawPr = null;
    f.lists = [
      { ...pr(), number: 13, url: "https://github.com/owner/repo/pull/13" },
      {
        ...pr(),
        number: 14,
        url: "https://github.com/owner/repo/pull/14",
        headRefName: "other",
        headRepositoryOwner: { login: "fork" },
      },
      { ...pr(), headRepositoryOwner: { login: "fork" } },
    ];
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "ready",
      repository: "owner/repo",
      headRepository: "fork/repo",
      pullRequest: { number: 12 },
    });
    expect(f.calls.some((c) => c.args.includes("github.com/owner/repo"))).toBe(true);
    expect(
      f.calls
        .filter((c) => c.file === "gh" && c.args[0] === "api")
        .every((c) => c.args.includes("github.com")),
    ).toBe(true);
  });
  it.each(["pushRemote", "pushDefault", "branchRemote"])(
    "resolves the fixed %s priority and verifies fork head independently from base",
    async (mode) => {
      const f = fixture();
      f.remotes.fork = "ssh://git@github.com/fork/repo.git";
      if (mode === "pushRemote") f.config["branch.topic.pushRemote"] = "fork";
      if (mode === "pushDefault") f.config["remote.pushDefault"] = "fork";
      if (mode === "branchRemote") f.config["branch.topic.remote"] = "fork";
      f.rawPr.headRepositoryOwner.login = "fork";
      f.lists = [f.rawPr];
      const r = await f.service.refresh(f.path);
      expect(r.snapshot).toMatchObject({
        status: "ready",
        repository: "owner/repo",
        headRepository: "fork/repo",
        pullRequest: { headRepository: "fork/repo" },
      });
      expect(
        f.calls.some(
          (c) => c.args[1] === "list" && c.args[c.args.indexOf("--head") + 1] === "topic",
        ),
      ).toBe(true);
    },
  );
  it("ignores dot and unsupported remotes; rejects detached HEAD and nonpublic hosts", async () => {
    const f = fixture();
    f.config["branch.topic.pushRemote"] = ".";
    f.config["remote.pushDefault"] = "enterprise";
    f.remotes.enterprise = "https://github.enterprise/repo/name.git";
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("ready");
    f.branch = "";
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "unavailable",
      branch: null,
      pullRequest: null,
    });
    f.branch = "topic";
    f.remotes.origin = "https://github.com.evil/owner/repo";
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("unavailable");
  });
  it("does not associate unverified tool URLs, head branches, deleted forks or ambiguous forks", async () => {
    const f = fixture();
    f.rawPr.headRefName = "other";
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("ambiguous");
    f.rawPr.headRefName = "topic";
    f.rawPr.headRepository = null;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "unavailable",
      pullRequest: { headRepository: null },
      checksComplete: false,
    });
    f.rawPr = pr();
    f.rawPr.headRepositoryOwner.login = "fork";
    f.config["branch.topic.pushRemote"] = "fork";
    f.remotes.fork = "https://github.com/fork/repo";
    f.lists = [f.rawPr, { ...f.rawPr, number: 13, url: "https://github.com/owner/repo/pull/13" }];
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("ambiguous");
    f.lists = Array.from({ length: 100 }, () => f.rawPr);
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("ambiguous");
  });
  it("keeps verified display association across restart but always revalidates it through gh", async () => {
    const f = fixture();
    await f.service.refresh(f.path);
    f.rawPr.state = "MERGED";
    const restarted = f.make();
    expect((await restarted.refresh(f.path)).snapshot.pullRequest?.state).toBe("MERGED");
    expect(
      f.calls.some((c) => c.args[0] === "pr" && c.args[1] === "view" && c.args[2] === "12"),
    ).toBe(true);
    f.rawPr = { ...pr(), number: 13, url: "https://github.com/owner/repo/pull/13" };
    expect((await f.make().refresh(f.path)).snapshot).toMatchObject({
      status: "error",
      pullRequest: { number: 12 },
    });
  });
  it("keeps the previously associated merged PR rather than substituting another", async () => {
    const f = fixture();
    await f.service.refresh(f.path);
    f.rawPr.state = "MERGED";
    expect((await f.service.refresh(f.path)).snapshot.pullRequest?.state).toBe("MERGED");
    expect(
      f.calls.some(
        (c) =>
          c.args[0] === "pr" &&
          c.args[1] === "view" &&
          c.args[2] === "12" &&
          c.args.includes("github.com/owner/repo"),
      ),
    ).toBe(true);
    f.rawPr.number = 13;
    f.rawPr.url = "https://github.com/owner/repo/pull/13";
    const r = await f.service.refresh(f.path);
    expect(r.snapshot.status).toBe("error");
    expect(r.snapshot.pullRequest?.number).toBe(12);
  });
  it("preserves stale successful data only for an unchanged head identity", async () => {
    const f = fixture();
    await f.service.refresh(f.path);
    f.intercept = ({ args }) =>
      args[0] === "pr" ? { code: 1, stdout: "", stderr: "HTTP 404" } : undefined;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "error",
      pullRequest: { number: 12 },
      checksComplete: false,
      threadsComplete: false,
    });
    f.branch = "new";
    expect((await f.service.refresh(f.path)).snapshot.pullRequest).toBeNull();
  });
  it("discards late results when the checkout identity changes during network work", async () => {
    const f = fixture();
    f.intercept = ({ args }) => {
      if (args[0] === "pr" && args[1] === "checks") f.branch = "other";
      return undefined;
    };
    const r = await f.service.refresh(f.path);
    expect(r.snapshot.status).toBe("unavailable");
    expect(r.snapshot.branch).toBe("other");
    expect(f.published).toEqual([]);
  });
  it.each([1, 8])(
    "parses checks JSON independent of normal gh exit %s and deduplicates IDs",
    async (exit) => {
      const f = fixture();
      f.checkExit = exit;
      f.checks = [check(), check(), { ...check(2), bucket: "new_upstream_bucket" }];
      const r = await f.service.refresh(f.path);
      expect(r.snapshot.checksComplete).toBe(true);
      expect(r.snapshot.checks).toHaveLength(2);
      expect(r.snapshot.checks[1]!.bucket).toBe("unknown");
    },
  );
  it("does not trust failed empty check output or JSON accompanied by a fetch error", async () => {
    const f = fixture();
    f.checkExit = 1;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "error",
      checksComplete: false,
    });
    f.intercept = ({ args }) =>
      args[0] === "pr" && args[1] === "checks"
        ? { ...result([check()], 1), stderr: "HTTP 403" }
        : undefined;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "error",
      checksComplete: false,
    });
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("HTTP 403");
    expect(puts(f)).toHaveLength(0);
  });
  it("does not accept unknown review decisions, malformed JSON or partial GraphQL as approval", async () => {
    const f = fixture();
    f.rawPr.reviewDecision = "NEW_DECISION";
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("error");
    f.rawPr.reviewDecision = null;
    f.intercept = ({ args }) =>
      args.includes("graphql")
        ? result({ data: null, errors: [{ message: "denied" }] })
        : undefined;
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("error");
    f.intercept = ({ args }) =>
      args[0] === "pr" ? { code: 0, stdout: "not-json", stderr: "" } : undefined;
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("error");
  });
  it("bounds cursor pagination, keeps unresolved outdated threads, and marks shortened Unicode comments", async () => {
    const f = fixture();
    f.pages = Array.from({ length: 5 }, (_, page) => ({
      pageInfo: { hasNextPage: true, endCursor: String(page + 1) },
      nodes: [
        {
          ...thread(String(page)),
          comments: {
            pageInfo: { hasNextPage: true },
            nodes: [{ ...comment(), body: "😀".repeat(8001) }],
          },
        },
      ],
    }));
    const r = await f.service.refresh(f.path);
    expect(r.snapshot.status).toBe("ready");
    expect(r.snapshot.threads).toHaveLength(5);
    expect(r.snapshot.threadsComplete).toBe(false);
    expect(r.snapshot.truncated).toBe(true);
    expect([...r.snapshot.threads[0]!.comments[0]!.body]).toHaveLength(8000);
    expect(f.calls.filter((c) => c.args.includes("graphql"))).toHaveLength(5);
  });
  it("caps check lists and the whole serialized snapshot without truncating identity", async () => {
    const f = fixture();
    f.checks = Array.from({ length: 501 }, (_, i) => check(i));
    f.pages[0].nodes = Array.from({ length: 100 }, (_, i) => ({
      ...thread(String(i)),
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: Array.from({ length: 10 }, (_, j) => ({
          ...comment(),
          id: `${i}-${j}`,
          body: "x".repeat(8000),
        })),
      },
    }));
    // A single API JSON response is independently bounded at 2 MiB; use smaller pages here.
    f.pages = Array.from({ length: 5 }, (_, page) => ({
      pageInfo: { hasNextPage: page < 4, endCursor: String(page + 1) },
      nodes: f.pages[0].nodes.slice(page * 20, page * 20 + 20),
    }));
    const r = await f.service.refresh(f.path);
    expect(r.snapshot.status).toBe("ready");
    expect(Buffer.byteLength(JSON.stringify(r.snapshot))).toBeLessThanOrEqual(512 * 1024);
    expect(r.snapshot.checksComplete).toBe(false);
    expect(r.snapshot.threadsComplete).toBe(false);
    expect(r.snapshot.truncated).toBe(true);
    expect(r.snapshot.pullRequest!.headRefOid).toBe(SHA);
  });
  it("runs only one trailing refresh when many hints arrive during in-flight discovery", async () => {
    const f = fixture();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let views = 0;
    f.intercept = async ({ args }) => {
      if (args[0] === "pr" && args[1] === "view" && ++views === 1) {
        reached();
        await gate;
      }
      return undefined;
    };
    f.service.observeToolOutput(f.path, {
      structuredContent: { output: "https://github.com/owner/repo/pull/12" },
    });
    await ready;
    for (let i = 0; i < 20; i++)
      f.service.observeToolOutput(f.path, {
        structuredContent: { output: "https://github.com/owner/repo/pull/12" },
      });
    // biome-ignore lint/complexity/useLiteralKeys: Wait for hint scheduling, not an arbitrary filesystem sleep.
    await vi.waitFor(() => expect(f.service["entries"].get(f.path)?.trailing).toBe(true));
    release();
    await vi.waitFor(() => expect(f.published).toHaveLength(2), { timeout: 2000 });
    expect(views).toBe(2);
  });
  it("never publishes a late refresh after shutdown", async () => {
    const f = fixture();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.intercept = async ({ args }) => {
      if (args[0] === "pr") {
        reached();
        await gate;
      }
      return undefined;
    };
    const pending = f.service.refresh(f.path);
    await ready;
    const stopped = f.service.stop();
    release();
    await stopped;
    await pending;
    expect(f.published).toHaveLength(0);
  });
  it("debounces both tool output forms, scans the tail, and runs at most one trailing refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const text = `${"x".repeat(150000)} https://github.com/owner/repo/pull/new/topic`;
    f.service.observeToolOutput(f.path, { content: [{ type: "text", text }] });
    f.service.observeToolOutput(f.path, {
      structuredContent: { output: "https://github.com/owner/repo/compare/main...topic" },
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // realpath is actual asynchronous filesystem I/O, not a timer.
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    expect(f.calls.filter((c) => c.args[0] === "pr" && c.args[1] === "view")).toHaveLength(1);
    f.service.observeToolOutput(f.path, {
      content: [{ type: "text", text: "https://github.com.evil/owner/repo/pull/12" }],
      fullOutputPath: "/must/not/read",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.published).toHaveLength(1);
  });
});

describe("SHA guarded squash merge", () => {
  it("requires the freshly verified PR node identity before any mutation", async () => {
    const f = fixture();
    expect((await f.service.refresh(f.path)).snapshot.pullRequest?.nodeId).toBe(NODE_ID);
    f.nodeId = "PR_replacement";
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("PR identity changed");
    expect(puts(f)).toHaveLength(0);
    f.nodeId = "";
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("node ID");
    expect(puts(f)).toHaveLength(0);
    await expect(f.service.merge(input(f) as any)).rejects.toThrow();
    expect(puts(f)).toHaveLength(0);
  });
  it("does not confirm an uncertain merge from a replacement PR with the same head", async () => {
    const f = fixture();
    f.mergeResponse = { code: null, stdout: "", stderr: "lost" };
    f.reconciled = { id: "PR_replacement", state: "MERGED", headRefOid: SHA, mergeCommit: null };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({ status: "outcome_unknown" });
    expect(puts(f)).toHaveLength(1);
  });
  it("keeps a deleted fork visible without authorizing merge", async () => {
    const f = fixture();
    await f.service.refresh(f.path);
    f.rawPr.headRepository = null;
    expect((await f.service.refresh(f.path)).snapshot).toMatchObject({
      status: "unavailable",
      pullRequest: { headRepository: null },
    });
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("head repository is unavailable");
    expect(puts(f)).toHaveLength(0);
  });
  it("does not clear an unknown outcome on failed Refresh", async () => {
    const f = fixture();
    f.mergeResponse = { code: null, stdout: "", stderr: "lost" };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({ status: "outcome_unknown" });
    f.intercept = ({ args }) =>
      args[0] === "pr" ? { code: 1, stdout: "", stderr: "HTTP 403" } : undefined;
    expect((await f.service.refresh(f.path)).snapshot.status).toBe("error");
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("Refresh before retrying");
    expect(puts(f)).toHaveLength(1);
  });
  it("stays unknown if a reread reports a different merged head", async () => {
    const f = fixture();
    f.mergeResponse = { code: null, stdout: "", stderr: "lost" };
    f.reconciled = { id: NODE_ID, state: "MERGED", headRefOid: OTHER, mergeCommit: { oid: OTHER } };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({ status: "outcome_unknown" });
    expect(puts(f)).toHaveLength(1);
  });
  it("uses only the direct SHA-guarded endpoint and returns confirmed success", async () => {
    const f = fixture();
    f.checks = [{ ...check(), bucket: "skipping" }];
    const merged = await f.service.merge(mergeInput(f));
    expect(GitHubMergeResult.safeParse(merged).success).toBe(true);
    expect(merged).toMatchObject({ status: "merged", mergeCommitOid: OTHER });
    expect(puts(f).map((c) => c.args)).toEqual([
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "PUT",
        "repos/owner/repo/pulls/12/merge",
        "-f",
        `sha=${SHA}`,
        "-f",
        "merge_method=squash",
      ],
    ]);
    expect(f.calls.some((c) => c.args[0] === "pr" && c.args[1] === "merge")).toBe(false);
  });
  it.each([
    ["state", "CLOSED", "not open"],
    ["isDraft", true, "Draft"],
    ["mergeable", "UNKNOWN", "mergeable"],
    ["mergeStateStatus", "BEHIND", "clean"],
    ["reviewDecision", "CHANGES_REQUESTED", "reviews"],
    ["reviewDecision", "REVIEW_REQUIRED", "reviews"],
  ])("rejects unsafe PR %s=%s", async (field, value, message) => {
    const f = fixture();
    f.rawPr[field as string] = value;
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow(String(message));
    expect(puts(f)).toHaveLength(0);
  });
  it.each([
    ["squashMergeAllowed", false, "Squash"],
    [
      "isMergeQueueEnabled",
      true,
      "Merge queues are not supported by this action; merge on GitHub.",
    ],
    ["isInMergeQueue", true, "Merge queues"],
    ["autoMergeRequest", {}, "Auto-merge"],
  ])("rejects unsafe repository setting %s", async (field, value, message) => {
    const f = fixture();
    f.settings[field as string] = value;
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow(String(message));
    expect(puts(f)).toHaveLength(0);
  });
  it.each(["fail", "pending", "cancel", "unknown"])("rejects %s checks", async (bucket) => {
    const f = fixture();
    f.checks = [{ ...check(), bucket }];
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("Checks");
    expect(puts(f)).toHaveLength(0);
  });
  it("rejects stale SHA, wrong base identity and incomplete thread/comment snapshots", async () => {
    const f = fixture();
    await expect(f.service.merge({ ...mergeInput(f), expectedHeadOid: OTHER })).rejects.toThrow(
      "head changed",
    );
    await expect(f.service.merge({ ...mergeInput(f), repository: "wrong/repo" })).rejects.toThrow(
      "association changed",
    );
    f.pages[0].nodes = [{ ...thread(), comments: { pageInfo: { hasNextPage: true }, nodes: [] } }];
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("incomplete");
    expect(puts(f)).toHaveLength(0);
  });
  it("allows no applicable review decision and complete empty checks", async () => {
    const f = fixture();
    f.rawPr.reviewDecision = "";
    f.mergeResponse = result({ merged: true });
    expect(await f.service.merge(mergeInput(f))).toMatchObject({
      status: "merged",
      mergeCommitOid: null,
    });
  });
  it("rereads after lost response and confirms a completed merge without retrying PUT", async () => {
    const f = fixture();
    f.mergeResponse = { code: null, stdout: "", stderr: "", timedOut: true };
    f.reconciled = { id: NODE_ID, state: "MERGED", headRefOid: SHA, mergeCommit: { oid: OTHER } };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({
      status: "merged",
      mergeCommitOid: OTHER,
    });
    expect(puts(f)).toHaveLength(1);
  });
  it("persists unknown outcomes, refuses retries across restart, and requires explicit refresh", async () => {
    const f = fixture();
    f.mergeResponse = { code: null, stdout: "", stderr: "disconnected" };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({ status: "outcome_unknown" });
    expect(f.published.at(-1).snapshot).toMatchObject({
      status: "error",
      reason: "Merge outcome unknown. Refresh before retrying.",
    });
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("Refresh before retrying");
    const restarted = f.make();
    await expect(restarted.merge(mergeInput(f))).rejects.toThrow("Refresh before retrying");
    expect(puts(f)).toHaveLength(1);
    await restarted.refresh(f.path);
    f.mergeResponse = result({ merged: true });
    expect(await restarted.merge(mergeInput(f))).toMatchObject({ status: "merged" });
    expect(puts(f)).toHaveLength(2);
  });
  it("does not erase confirmed success on post-merge refresh failure", async () => {
    const f = fixture();
    let didPut = false;
    f.intercept = ({ args }) => {
      if (args.includes("PUT")) didPut = true;
      else if (didPut && args[0] === "pr")
        return { code: 1, stdout: "", stderr: "network failure" };
      return undefined;
    };
    expect(await f.service.merge(mergeInput(f))).toMatchObject({ status: "merged" });
  });
  it("never elevates or retries a definitive branch-protection rejection", async () => {
    const f = fixture();
    f.mergeResponse = { code: 1, stdout: "", stderr: "HTTP 405 branch protection" };
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("branch protection");
    expect(puts(f)).toHaveLength(1);
  });
  it("serializes even direct calls and does not let Refresh clear an in-flight mutation fence", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.intercept = async ({ args }) => {
      if (args.includes("PUT")) {
        reached();
        await gate;
      }
      return undefined;
    };
    f.mergeResponse = { code: null, stdout: "", stderr: "lost" };
    const first = f.service.merge(mergeInput(f));
    await ready;
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("already in progress");
    await f.service.refresh(f.path);
    release();
    await first;
    await expect(f.service.merge(mergeInput(f))).rejects.toThrow("Refresh before retrying");
    expect(puts(f)).toHaveLength(1);
  });
});

describe("verified failed Actions job logs", () => {
  it("keeps unknown enumeration coverage distinct from successful zero failed checks", async () => {
    const f = fixture();
    const zero = await f.service.failedLogs(input(f));
    expect(zero).toMatchObject({ status: "ready", jobs: [], complete: true, omittedJobs: 0 });
  });
  it("preserves decimal string Actions IDs larger than the JS safe integer range", async () => {
    const f = fixture();
    const runId = "9007199254740993",
      jobId = "9007199254740995";
    f.checks = [
      { ...check(), link: `https://github.com/owner/repo/actions/runs/${runId}/job/${jobId}` },
    ];
    f.run.id = runId;
    f.intercept = ({ args }) =>
      args.at(-1) === `repos/owner/repo/actions/jobs/${jobId}`
        ? result({ ...f.job, id: jobId, run_id: runId })
        : undefined;
    expect((await f.service.failedLogs(input(f))).jobs[0]).toMatchObject({
      status: "available",
      runId,
      jobId,
    });
    expect(logCalls(f)[0]!.args).toContain(jobId);
  });
  it("verifies run/job/head and reads the whole job, not log-failed", async () => {
    const f = fixture();
    f.checks = [check()];
    const r = await f.service.failedLogs(input(f));
    expect(GitHubLogs.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ status: "ready", complete: true, omittedJobs: 0 });
    expect(r.jobs[0]).toMatchObject({
      status: "available",
      runId: "100",
      jobId: "201",
      attempt: 1,
      outputTail: "start\nfailed\ncleanup\n",
      lineCount: 3,
    });
    expect(logCalls(f)[0]!.args).toEqual([
      "run",
      "view",
      "--repo",
      "github.com/owner/repo",
      "--job",
      "201",
      "--log",
    ]);
    expect(f.published.every((p) => !JSON.stringify(p.snapshot).includes("outputTail"))).toBe(true);
  });
  it("uses the verified job attempt for an unqualified job link and rejects explicit mismatches", async () => {
    const f = fixture();
    f.run.run_attempt = 2;
    f.checks = [check()];
    expect((await f.service.failedLogs(input(f))).jobs[0]).toMatchObject({
      status: "available",
      runId: "100",
      jobId: "201",
      attempt: 1,
    });
    f.checks = [
      { ...check(), link: "https://github.com/owner/repo/actions/runs/100/attempts/2/job/201" },
    ];
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("unmapped");
    expect(logCalls(f)).toHaveLength(1);
  });
  it.each([
    "https://external.invalid/job/1",
    "https://github.com/other/repo/actions/runs/100/job/201",
    "http://github.com/owner/repo/actions/runs/100/job/201",
    "https://user@github.com/owner/repo/actions/runs/100/job/201",
    "https://github.com:444/owner/repo/actions/runs/100/job/201",
  ])("never fetches untrusted link %s", async (link) => {
    const f = fixture();
    f.checks = [{ ...check(), link }];
    const r = await f.service.failedLogs(input(f));
    expect(r.jobs[0]!.status).toBe("unmapped");
    expect(r.complete).toBe(false);
    expect(logCalls(f)).toHaveLength(0);
  });
  it.each(["head", "runId", "attempt", "unsafeId"])(
    "rejects unverified job mapping: %s",
    async (mode) => {
      const f = fixture();
      f.checks = [check()];
      if (mode === "head") f.run.head_sha = OTHER;
      if (mode === "runId") f.job.run_id = 101;
      if (mode === "attempt") f.job.run_attempt = 2;
      if (mode === "unsafeId") f.run.id = 9007199254740992;
      const r = await f.service.failedLogs(input(f));
      expect(r.jobs[0]!.status).not.toBe("available");
      expect(logCalls(f)).toHaveLength(0);
    },
  );
  it("resolves check-run IDs via details_url and never equates them with job IDs", async () => {
    const f = fixture();
    f.checks = [
      { ...check(), link: "https://github.com/owner/repo/runs/999?check_suite_focus=true" },
    ];
    expect((await f.service.failedLogs(input(f))).jobs[0]).toMatchObject({
      status: "available",
      jobId: "201",
    });
    expect(f.calls.some((c) => c.args.at(-1) === "repos/owner/repo/check-runs/999")).toBe(true);
    expect(logCalls(f)[0]!.args).not.toContain("999");
    f.checkRun.head_sha = OTHER;
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("unmapped");
  });
  it("enumerates run attempts with explicit bounded pages and rejects ambiguity", async () => {
    const f = fixture();
    f.checks = [{ ...check(), link: "https://github.com/owner/repo/actions/runs/100/attempts/1" }];
    f.jobPages = [{ jobs: [f.job] }];
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("available");
    f.jobPages = [{ jobs: [f.job, { ...f.job, id: 202 }] }];
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("unmapped");
    f.jobPages = Array.from({ length: 5 }, () => ({
      jobs: Array.from({ length: 100 }, () => ({ ...f.job, name: "not-this-check" })),
    }));
    const before = f.calls.length;
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("unmapped");
    expect(
      f.calls.slice(before).filter((c) => c.args.at(-1)!.includes("/attempts/1/jobs?")),
    ).toHaveLength(5);
    expect(f.calls.some((c) => c.args.includes("--paginate"))).toBe(false);
  });
  it.each(["", "\n", "\n\n", "a\r\nb\r\n", "😀".repeat(20000)])(
    "tails valid UTF-8 and counts lines for edge case %#",
    async (logs) => {
      const f = fixture();
      f.checks = [check()];
      f.logs = logs;
      const r = await f.service.failedLogs(input(f));
      expect(r.jobs[0]!.status).toBe("available");
      expect(Buffer.byteLength(r.jobs[0]!.outputTail!)).toBeLessThanOrEqual(65536);
      expect(r.jobs[0]!.outputTail).not.toContain("�");
      expect(GitHubLogs.safeParse(r).success).toBe(true);
    },
  );
  it("tails the last 150 whole-job lines and reports truncation without claiming missing jobs", async () => {
    const f = fixture();
    f.checks = [check()];
    f.logs = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const r = await f.service.failedLogs(input(f));
    expect(r).toMatchObject({ complete: true, truncated: true });
    expect(r.jobs[0]).toMatchObject({ lineCount: 150, truncated: true });
    expect(r.jobs[0]!.outputTail).toMatch(/^line 50\n/);
    expect(r.jobs[0]!.outputTail).toContain("line 199");
  });
  it("limits failed jobs to ten with concurrency two and exact omitted coverage", async () => {
    const f = fixture();
    f.checks = Array.from({ length: 12 }, (_, i) => check(i + 1));
    let live = 0,
      max = 0;
    f.intercept = async ({ args }) => {
      if (args[0] === "run") {
        live++;
        max = Math.max(live, max);
        await new Promise((r) => setTimeout(r, 2));
        live--;
      }
      return undefined;
    };
    const r = await f.service.failedLogs(input(f));
    expect(r.jobs).toHaveLength(10);
    expect(r.omittedJobs).toBe(2);
    expect(r.complete).toBe(false);
    expect(r.truncated).toBe(true);
    expect(max).toBe(2);
  });
  it.each([
    ["HTTP 403 forbidden", "forbidden"],
    ["HTTP 410 expired logs", "expired"],
    ["network failure", "error"],
    ["timeout", "timeout"],
  ])("reports %s without exposing partial stdout", async (message, status) => {
    const f = fixture();
    f.checks = [check()];
    f.intercept = ({ args }) =>
      args[0] === "run"
        ? {
            code: 1,
            stdout: "partial must not become evidence",
            stderr: message,
            timedOut: status === "timeout",
          }
        : undefined;
    const r = await f.service.failedLogs(input(f));
    expect(r.jobs[0]).toMatchObject({ status, outputTail: null, lineCount: 0 });
    expect(r.complete).toBe(false);
  });
  it("marks unfinished runs incomplete and rejects stale SHA as conflict", async () => {
    const f = fixture();
    f.checks = [check()];
    f.run.status = "in_progress";
    expect((await f.service.failedLogs(input(f))).jobs[0]!.status).toBe("incomplete");
    expect(logCalls(f)).toHaveLength(0);
    await expect(f.service.failedLogs({ ...input(f), expectedHeadOid: OTHER })).rejects.toThrow(
      "head changed",
    );
  });
  it("represents unavailable auth and incomplete check enumeration honestly", async () => {
    const f = fixture();
    f.auth = false;
    expect(await f.service.failedLogs(input(f))).toMatchObject({
      status: "unavailable",
      jobs: [],
      complete: false,
      omittedJobs: null,
    });
    f.auth = true;
    f.checks = Array.from({ length: 501 }, (_, i) => check(i + 1));
    const r = await f.service.failedLogs(input(f));
    expect(r.omittedJobs).toBeNull();
    expect(r.complete).toBe(false);
  });
});
