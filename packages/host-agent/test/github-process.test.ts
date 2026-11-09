import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GitHubProcessOptions, GitHubService } from "../src/github.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture() {
  const dir = tempDir();
  const service = new GitHubService();
  cleanups.push(dir.cleanup, () => service.stop());
  const options: GitHubProcessOptions = {
    cwd: dir.path,
    env: process.env,
    timeoutMs: 20000,
    tail: false,
  };
  return { service, dir, options };
}

describe("private GitHub argv subprocess runner", () => {
  it("enforces the actual 2 MiB JSON stdout and 8 KiB stderr bounds", async () => {
    const { service, options } = fixture();
    // biome-ignore lint/complexity/useLiteralKeys: Test private process limits without exposing another runner API.
    const r = await service["runProcess"](
      process.execPath,
      [
        "-e",
        'process.stderr.write("x".repeat(20000)); process.stdout.write("a".repeat(3*1024*1024));',
      ],
      options,
    );
    expect(r.tooLarge).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(8192);
  });
  it("streams a UTF-8 tail rather than accumulating complete logs, and never expands shell syntax", async () => {
    const { service, options } = fixture();
    // biome-ignore lint/complexity/useLiteralKeys: Exercise streaming and argument preservation through the actual private runner.
    const r = await service["runProcess"](
      process.execPath,
      [
        "-e",
        'process.stdout.write("😀".repeat(40000)+"\\n"+process.argv[1]);',
        "$(touch must-not-exist); --admin",
      ],
      { ...options, tail: true },
    );
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(65536);
    expect(r.stdout).not.toContain("�");
    expect(r.stdout).toContain("$(touch must-not-exist); --admin");
    expect(existsSync(join(options.cwd, "must-not-exist"))).toBe(false);
  });
  it("times out and SIGKILLs the whole process group, including TERM-resistant descendants", async () => {
    const { service, options } = fixture();
    const pidFile = join(options.cwd, "grandchild.pid");
    const childCode = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`;
    const code = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
    // biome-ignore lint/complexity/useLiteralKeys: Verify actual process group cleanup, not mocked signals.
    const running = service["runProcess"](process.execPath, ["-e", code], {
      ...options,
      timeoutMs: 300,
    });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    const r = await running;
    expect(r.timedOut).toBe(true);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }, 10000);
  it("stops probe children during shutdown without waiting for their network timeout", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const gh = join(dir.path, "gh"),
      pidFile = join(dir.path, "probe.pid");
    writeFileSync(
      gh,
      `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);\n`,
    );
    chmodSync(gh, 0o755);
    const service = new GitHubService({ env: { PATH: `${dir.path}:${process.env.PATH}` } });
    cleanups.push(() => service.stop());
    const probe = service.probe();
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await service.stop();
    expect((await probe).available).toBe(false);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }, 10000);
  it("uses real git argv for branch/push-remote discovery while pinning gh to public github.com", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    execFileSync("git", ["init", "-b", "topic", dir.path], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      dir.path,
      "remote",
      "add",
      "origin",
      "git@github.com:owner/repo.git",
    ]);
    const gh = join(dir.path, "gh");
    const sha = "a".repeat(40);
    const pr = {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      title: "Change",
      state: "OPEN",
      isDraft: false,
      headRefName: "topic",
      headRefOid: sha,
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "owner" },
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
    };
    const graphql = {
      data: {
        repository: {
          squashMergeAllowed: true,
          pullRequest: {
            id: "PR_node_1",
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
            autoMergeRequest: null,
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    };
    writeFileSync(
      gh,
      `#!${process.execPath}\nconst a=process.argv.slice(2); if(process.env.GH_HOST!=='github.com'||process.env.GH_REPO) process.exit(1); if(a[0]==='--version'||a[0]==='auth') console.log('ok'); else if(a[0]==='pr'&&a[1]==='view') { if(!a.includes('github.com/owner/repo')) process.exit(1); console.log(${JSON.stringify(JSON.stringify(pr))}); } else if(a[0]==='pr') console.log('[]'); else if(a.at(-1)==='repos/owner/repo') console.log(JSON.stringify({full_name:'owner/repo',fork:false})); else console.log(${JSON.stringify(JSON.stringify(graphql))});\n`,
    );
    chmodSync(gh, 0o755);
    const service = new GitHubService({
      env: { PATH: `${dir.path}:${process.env.PATH}`, GH_REPO: "enterprise.invalid/evil/repo" },
    });
    cleanups.push(() => service.stop());
    const r = await service.refresh(dir.path);
    expect(r.snapshot).toMatchObject({
      status: "ready",
      branch: "topic",
      repository: "owner/repo",
      pullRequest: { nodeId: "PR_node_1" },
      checksComplete: true,
      threadsComplete: true,
    });
  });
});
