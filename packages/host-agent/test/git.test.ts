import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwitchyardError } from "@switchyard/protocol";
import { makeRepo, type TempRepo } from "@switchyard/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyWorktreeIncludes,
  createWorktree,
  diffWorkspace,
  discoverWorktrees,
  inspectCheckout,
  managedWorktreePath,
  normalizeRemote,
  parseWorktreePorcelain,
  removeWorktree,
  runSetup,
  validateBranch,
  worktreeStatus,
} from "../src/git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<SwitchyardError> {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, but it succeeded`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SwitchyardError);
  expect((err as SwitchyardError).code).toBe(code);
  return err as SwitchyardError;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo(opts: { remote?: string } = {}): TempRepo {
  const r = makeRepo(opts);
  cleanups.push(r.cleanup);
  return r;
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-git-test-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("normalizeRemote", () => {
  it.each([
    ["git@GitHub.com:Me/Repo.git", "https://github.com/Me/Repo"],
    ["https://GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
    ["https://github.com/Me/Repo/", "https://github.com/Me/Repo"],
    ["ssh://git@GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
    ["ssh://git@github.com:22/Me/Repo", "https://github.com/Me/Repo"],
    ["https://user:token@github.com/Me/Repo.git", "https://github.com/Me/Repo"],
    ["github.com:Me/Repo", "https://github.com/Me/Repo"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected);
  });
});

describe("parseWorktreePorcelain", () => {
  it("parses NUL-separated records", () => {
    const out =
      "worktree /r\0HEAD abc\0branch refs/heads/main\0\0" +
      "worktree /r/.worktrees/feat-x\0HEAD def\0branch refs/heads/feat/x\0locked reason here\0\0" +
      "worktree /gone\0HEAD 123\0detached\0prunable gitdir file points to non-existent location\0\0" +
      "worktree /bare\0bare\0\0";
    expect(parseWorktreePorcelain(out)).toEqual([
      {
        path: "/r",
        head: "abc",
        branch: "main",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/r/.worktrees/feat-x",
        head: "def",
        branch: "feat/x",
        bare: false,
        detached: false,
        locked: true,
        prunable: false,
      },
      {
        path: "/gone",
        head: "123",
        branch: null,
        bare: false,
        detached: true,
        locked: false,
        prunable: true,
      },
      {
        path: "/bare",
        head: null,
        branch: null,
        bare: true,
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);
  });
});

describe("inspectCheckout", () => {
  it("describes a local repository", async () => {
    const r = repo();
    const sha = git(r.path, ["rev-parse", "HEAD"]).trim();
    const info = await inspectCheckout(r.path);
    expect(info).toEqual({
      root: r.path,
      commonDir: join(r.path, ".git"),
      repoIdentity: `local:${sha}`,
      defaultBranch: "main",
    });
  });

  it("uses the normalized origin remote and resolves from a subdirectory", async () => {
    const r = repo({ remote: "git@GitHub.com:Me/Repo.git" });
    execFileSync("mkdir", ["-p", join(r.path, "sub")]);
    const info = await inspectCheckout(join(r.path, "sub"));
    expect(info.root).toBe(r.path);
    expect(info.repoIdentity).toBe("https://github.com/Me/Repo");
    expect(info.defaultBranch).toBe("main");
  });

  it("reads the default branch from origin/HEAD", async () => {
    const r = repo({ remote: "https://example.com/x/y.git" });
    git(r.path, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    git(r.path, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    expect((await inspectCheckout(r.path)).defaultBranch).toBe("trunk");
  });

  it("rejects non-repositories and missing directories", async () => {
    const dir = tempDir();
    const err = await expectCode(inspectCheckout(dir), "not_a_git_repo");
    expect(err.message).toBe(`${dir} is not a git repository`);
    await expectCode(inspectCheckout(join(dir, "missing")), "not_a_git_repo");
  });
});

describe("validateBranch", () => {
  it("accepts valid names and rejects invalid ones", async () => {
    await validateBranch("feat/x");
    await validateBranch("main");
    for (const bad of ["bad..name", "-x", "", "a b", "x.lock", "x~1"]) {
      const err = await expectCode(validateBranch(bad), "branch_invalid");
      expect(err.message).toBe(`Invalid branch name: ${bad}`);
    }
  });
});

describe("worktrees", () => {
  let r: TempRepo;
  beforeEach(() => {
    r = repo();
  });

  it("creates a managed worktree that is ignored by the main checkout", async () => {
    const created = await createWorktree(r.path, "feat/x", "main");
    const expected = join(r.path, ".worktrees", "feat-x");
    expect(created).toEqual({
      path: expected,
      branch: "feat/x",
      baseBranch: "main",
      root: r.path,
    });
    expect(managedWorktreePath(r.path, "feat/x")).toBe(expected);
    expect(git(expected, ["branch", "--show-current"]).trim()).toBe("feat/x");
    const exclude = readFileSync(join(r.path, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain("/.worktrees/");
    expect(git(r.path, ["status", "--porcelain"])).toBe("");

    // A second worktree does not append the exclude line again.
    await createWorktree(r.path, "other", "main");
    const again = readFileSync(join(r.path, ".git", "info", "exclude"), "utf8");
    expect(again.split("\n").filter((l) => l === "/.worktrees/")).toHaveLength(1);
  });

  describe(".worktreeinclude", () => {
    const setup = () => {
      writeFileSync(join(r.path, ".gitignore"), ".env\nnode_modules/\n.worktrees/\n");
      writeFileSync(join(r.path, ".worktreeinclude"), ".env\nnotignored.txt\n*.cfg\n");
      writeFileSync(join(r.path, ".env"), "SECRET=1\n");
      writeFileSync(join(r.path, "notignored.txt"), "x");
    };

    it("copies matching ignored files only", async () => {
      setup();
      const created = await createWorktree(r.path, "inc", "main");
      expect(readFileSync(join(created.path, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(existsSync(join(created.path, "notignored.txt"))).toBe(false);
      expect(existsSync(join(created.path, ".worktrees"))).toBe(false);
    });

    it("copies nothing without a .worktreeinclude", async () => {
      writeFileSync(join(r.path, ".gitignore"), ".env\n");
      writeFileSync(join(r.path, ".env"), "x");
      const created = await createWorktree(r.path, "none", "main");
      expect(existsSync(join(created.path, ".env"))).toBe(false);
    });

    it("skips files already present in the destination", async () => {
      setup();
      const dest = tempDir();
      writeFileSync(join(dest, ".env"), "keep");
      expect(await copyWorktreeIncludes(r.path, dest, ".worktrees")).toBe(0);
      expect(readFileSync(join(dest, ".env"), "utf8")).toBe("keep");
    });

    it("fails over the limit and leaves no worktree or branch", async () => {
      setup();
      const dest = tempDir();
      await expect(copyWorktreeIncludes(r.path, dest, ".worktrees", 0)).rejects.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("checks out an existing branch", async () => {
    git(r.path, ["branch", "existing"]);
    const created = await createWorktree(r.path, "existing", "main");
    expect(git(created.path, ["branch", "--show-current"]).trim()).toBe("existing");
  });

  it("refuses collisions", async () => {
    await createWorktree(r.path, "feat/x", "main");
    await expectCode(createWorktree(r.path, "feat/x", "main"), "path_collision");
    await expectCode(createWorktree(r.path, "feat-x", "main"), "path_collision");
  });

  it("refuses a branch that is checked out elsewhere", async () => {
    const err = await expectCode(createWorktree(r.path, "main", "main"), "path_collision");
    expect(err.message).toBe(`Branch main is already checked out at ${r.path}`);
  });

  it("refuses a slug collision with a worktree outside .worktrees", async () => {
    const ext = join(tempDir(), "ext");
    git(r.path, ["worktree", "add", ext, "-b", "feat-y"]);
    await expectCode(createWorktree(r.path, "feat/y", "main"), "path_collision");
  });

  it("refuses invalid branch names", async () => {
    await expectCode(createWorktree(r.path, "bad..name", "main"), "branch_invalid");
    await expectCode(createWorktree(r.path, "-x", "main"), "branch_invalid");
    expect(existsSync(join(r.path, ".worktrees"))).toBe(false);
  });

  it("discovers worktrees with provenance and status", async () => {
    const managed = await createWorktree(r.path, "feat/x", "main");
    const ext = join(tempDir(), "ext");
    git(r.path, ["worktree", "add", ext, "-b", "ext"]);
    writeFileSync(join(ext, "new.txt"), "hello\n");

    const found = await discoverWorktrees(r.path);
    const byPath = new Map(found.map((w) => [w.path, w]));
    expect(found).toHaveLength(3);
    expect(byPath.get(r.path)).toMatchObject({ provenance: "main", branch: "main" });
    expect(byPath.get(managed.path)).toMatchObject({
      provenance: "managed",
      branch: "feat/x",
      git: { dirty: false, changedFiles: 0, unmerged: false },
    });
    expect(byPath.get(ext)).toMatchObject({
      provenance: "discovered",
      branch: "ext",
      bare: false,
      detached: false,
      git: { dirty: true, changedFiles: 1 },
    });

    // Discovering from a linked worktree resolves the same root; status can be skipped.
    const noStatus = await discoverWorktrees(managed.path, { withStatus: false });
    expect(noStatus.every((w) => w.git === null)).toBe(true);
  });

  it("follows a project's worktree folder for the path, the exclude line and discovery", async () => {
    const created = await createWorktree(r.path, "feat/x", "main", "wt");
    const expected = join(r.path, "wt", "feat-x");
    expect(created.path).toBe(expected);
    expect(managedWorktreePath(r.path, "feat/x", "wt")).toBe(expected);
    const exclude = readFileSync(join(r.path, ".git", "info", "exclude"), "utf8").split("\n");
    expect(exclude).toContain("/wt/");
    expect(exclude).not.toContain("/.worktrees/");
    expect(git(r.path, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(r.path, ".worktrees"))).toBe(false);

    await createWorktree(r.path, "other", "main", "wt");
    const again = readFileSync(join(r.path, ".git", "info", "exclude"), "utf8").split("\n");
    expect(again.filter((l) => l === "/wt/")).toHaveLength(1);

    // Classification follows the folder: under wt/ is managed, the default folder is not.
    const legacy = await createWorktree(r.path, "legacy", "main");
    const found = await discoverWorktrees(r.path, { withStatus: false, worktreeDir: "wt" });
    const byPath = new Map(found.map((w) => [w.path, w.provenance]));
    expect(byPath.get(r.path)).toBe("main");
    expect(byPath.get(expected)).toBe("managed");
    expect(byPath.get(legacy.path)).toBe("discovered");
    const byDefault = await discoverWorktrees(r.path, { withStatus: false });
    expect(byDefault.find((w) => w.path === expected)?.provenance).toBe("discovered");
  });

  it("accepts a nested worktree folder", async () => {
    const created = await createWorktree(r.path, "feat/x", "main", ".git/worktrees-switchyard");
    expect(created.path).toBe(join(r.path, ".git", "worktrees-switchyard", "feat-x"));
    const found = await discoverWorktrees(r.path, {
      withStatus: false,
      worktreeDir: ".git/worktrees-switchyard",
    });
    expect(found.find((w) => w.path === created.path)?.provenance).toBe("managed");
  });

  it("rejects worktree folders outside the checkout", async () => {
    for (const bad of ["../x", "/abs", "a/../../x", "", "wt\\x", "./wt", "wt/"]) {
      await expectCode(createWorktree(r.path, "feat/x", "main", bad), "invalid_request");
      await expectCode(discoverWorktrees(r.path, { worktreeDir: bad }), "invalid_request");
      expect(() => managedWorktreePath(r.path, "feat/x", bad)).toThrow(SwitchyardError);
    }
    expect(existsSync(join(r.path, ".worktrees"))).toBe(false);
  });

  it("reports dirty, changed files and unmerged commits", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    expect(await worktreeStatus(path, null)).toEqual({
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      unmerged: false,
    });

    writeFileSync(join(path, "README.md"), "# changed\n");
    writeFileSync(join(path, "a.txt"), "a\n");
    const dirty = await worktreeStatus(path, null);
    expect(dirty).toMatchObject({ dirty: true, changedFiles: 2, unmerged: false });

    git(path, ["add", "-A"]);
    git(path, ["commit", "-q", "-m", "work"]);
    expect(await worktreeStatus(path, "main")).toMatchObject({
      dirty: false,
      changedFiles: 0,
      unmerged: true,
    });
    // An unknown base is never "unmerged".
    expect((await worktreeStatus(path, "nope")).unmerged).toBe(false);
  });

  it("reports ahead/behind of the upstream", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    git(path, ["branch", "--set-upstream-to", "main"]);
    writeFileSync(join(path, "a.txt"), "a\n");
    git(path, ["add", "a.txt"]);
    git(path, ["commit", "-q", "-m", "a"]);
    expect(await worktreeStatus(path, "main")).toMatchObject({ ahead: 1, behind: 0 });
  });

  it("diffs committed, uncommitted and untracked changes against the merge base", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    writeFileSync(join(path, "committed.txt"), "one\ntwo\n");
    git(path, ["add", "committed.txt"]);
    git(path, ["commit", "-q", "-m", "committed"]);
    // A later commit on main must not show up in the diff.
    writeFileSync(join(r.path, "main-only.txt"), "main\n");
    git(r.path, ["add", "main-only.txt"]);
    git(r.path, ["commit", "-q", "-m", "main only"]);

    writeFileSync(join(path, "README.md"), "# test repo\nmore\n");
    writeFileSync(join(path, "untracked.txt"), "u1\nu2\nu3\n");
    writeFileSync(join(path, "blob.bin"), Buffer.from([0, 1, 2, 3]));

    const diff = await diffWorkspace(path, null, null);
    expect(diff.base).toBe("main");
    const files = new Map(diff.files.map((f) => [f.path, f]));
    expect(files.get("committed.txt")).toEqual({
      path: "committed.txt",
      oldPath: null,
      added: 2,
      deleted: 0,
      status: "added",
    });
    expect(files.get("README.md")).toEqual({
      path: "README.md",
      oldPath: null,
      added: 1,
      deleted: 0,
      status: "modified",
    });
    expect(files.get("untracked.txt")).toEqual({
      path: "untracked.txt",
      oldPath: null,
      added: 3,
      deleted: 0,
      status: "untracked",
    });
    expect(files.get("blob.bin")).toMatchObject({ status: "untracked", added: 0 });
    expect(files.has("main-only.txt")).toBe(false);

    expect(diff.patch).toContain("diff --git a/committed.txt b/committed.txt");
    expect(diff.patch).toContain("+more");
    expect(diff.patch).toContain(
      "diff --git a/untracked.txt b/untracked.txt\nnew file mode 100644\n--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1,3 @@\n+u1\n+u2\n+u3\n",
    );
    expect(diff.patch).toContain("Binary files /dev/null and b/blob.bin differ");

    const one = await diffWorkspace(path, "main", "untracked.txt");
    expect(one.files).toHaveLength(diff.files.length);
    expect(one.patch).toContain("+++ b/untracked.txt");
    expect(one.patch).not.toContain("committed.txt");
    expect(one.files.find((f) => f.path === "untracked.txt")?.added).toBe(3);

    const readme = await diffWorkspace(path, "main", "README.md");
    expect(readme.patch).toContain("+more");
    expect(readme.patch).not.toContain("untracked.txt");
    expect(readme.files.find((f) => f.path === "untracked.txt")).toMatchObject({
      status: "untracked",
      added: 0,
    });
  });

  it("detects renames and binary changes", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    git(path, ["mv", "README.md", "RENAMED.md"]);
    writeFileSync(join(path, "img.bin"), Buffer.from([0, 255, 0, 1]));
    git(path, ["add", "img.bin"]);
    git(path, ["commit", "-q", "-m", "rename"]);
    const diff = await diffWorkspace(path, null, null);
    const files = new Map(diff.files.map((f) => [f.path, f]));
    expect(files.get("RENAMED.md")).toMatchObject({ oldPath: "README.md", status: "renamed" });
    expect(files.get("img.bin")).toMatchObject({ status: "binary", added: 0, deleted: 0 });
  });

  it("caps the full patch at 2 MB", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    const big = `${"x".repeat(99)}\n`.repeat(25_000); // 2.5 MB
    writeFileSync(join(path, "big.txt"), big);
    git(path, ["add", "big.txt"]);
    git(path, ["commit", "-q", "-m", "big"]);
    const diff = await diffWorkspace(path, null, null);
    expect(diff.patch).toBeNull();
    expect(diff.files[0]).toMatchObject({ path: "big.txt", added: 25_000 });
  });

  it("guards worktree removal", async () => {
    const { path } = await createWorktree(r.path, "feat/x", "main");
    const base = { checkoutPath: r.path, base: null };
    const noForce = { dirty: false, unmerged: false };

    await expectCode(
      removeWorktree({ ...base, path: r.path, force: { dirty: true, unmerged: true } }),
      "forbidden",
    );
    await expectCode(removeWorktree({ ...base, path: tempDir(), force: noForce }), "not_found");
    const active = await expectCode(
      removeWorktree({ ...base, path, force: noForce, hasActiveSession: (p) => p === path }),
      "workspace_active_sessions",
    );
    expect(active.message).toBe("Stop the sessions in this workspace before removing it");

    writeFileSync(join(path, "a.txt"), "a\n");
    await expectCode(removeWorktree({ ...base, path, force: noForce }), "workspace_dirty");
    git(path, ["add", "a.txt"]);
    git(path, ["commit", "-q", "-m", "a"]);
    const unmerged = await expectCode(
      removeWorktree({ ...base, path, force: noForce }),
      "workspace_unmerged",
    );
    expect(unmerged.message).toBe("Workspace has commits not merged into main");

    writeFileSync(join(path, "b.txt"), "b\n");
    await removeWorktree({ ...base, path, force: { dirty: true, unmerged: true } });
    expect(existsSync(path)).toBe(false);
    expect(git(r.path, ["rev-parse", "--verify", "refs/heads/feat/x"]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect((await discoverWorktrees(r.path, { withStatus: false })).map((w) => w.path)).toEqual([
      r.path,
    ]);
  });

  it("removes a clean merged worktree without force", async () => {
    const { path } = await createWorktree(r.path, "clean", "main");
    await removeWorktree({
      path,
      checkoutPath: r.path,
      base: null,
      force: { dirty: false, unmerged: false },
    });
    expect(existsSync(path)).toBe(false);
  });
});

describe("runSetup", () => {
  it("captures output and succeeds", async () => {
    const dir = tempDir();
    const result = await runSetup(dir, "echo hello; echo oops 1>&2; pwd");
    expect(result.state).toBe("succeeded");
    expect(result.log).toContain("hello");
    expect(result.log).toContain("oops");
    expect(result.log).toContain(dir);
  });

  it("fails with the exit code", async () => {
    const dir = tempDir();
    const result = await runSetup(dir, "echo boom; exit 3");
    expect(result.state).toBe("failed");
    expect(result.log).toBe("boom\nexit code 3");
  });

  it("fails on timeout", async () => {
    const dir = tempDir();
    const started = Date.now();
    const result = await runSetup(dir, "sleep 30", { timeoutMs: 200 });
    expect(result.state).toBe("failed");
    expect(result.log).toContain("timed out after 200 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
