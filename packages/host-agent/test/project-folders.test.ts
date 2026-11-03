import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, scanProjectFolder } from "../src/project-folders.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
}

function initRepo(dir: string, remote?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Switchyard Test"]);
  git(dir, ["config", "user.email", "test@switchyard.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# x\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-folders-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error("expected a rejection"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SwitchyardError);
  expect((err as SwitchyardError).code).toBe(code);
}

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/Projects", "/home/me")).toBe("/home/me/Projects");
    expect(expandHome("/srv/x", "/home/me")).toBe("/srv/x");
    expect(expandHome("~other/x", "/home/me")).toBe("~other/x");
  });
});

describe("scanProjectFolder", () => {
  it("finds main checkouts one level down and skips everything else", async () => {
    const root = tempDir();
    initRepo(join(root, "a"), "git@github.com:me/a.git");
    initRepo(join(root, "b"));
    initRepo(join(root, ".hidden"));
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "file.txt"), "x");
    initRepo(join(root, "group", "nested"));
    git(join(root, "a"), ["worktree", "add", "-q", join(root, "wt"), "-b", "wt"]);

    const scan = await scanProjectFolder(root);
    expect(scan.folder).toBe(root);
    expect(scan.repositories.map((r) => r.name)).toEqual(["a", "b"]);
    const a = scan.repositories[0]!;
    expect(a.repoIdentity).toBe("https://github.com/me/a");
    expect(a.root).toBe(join(root, "a"));
    expect(scan.repositories[1]!.repoIdentity).toMatch(/^local:/);
  });

  it("expands ~ against the given home", async () => {
    const home = tempDir();
    initRepo(join(home, "Projects", "x"));
    const scan = await scanProjectFolder("~/Projects", { home });
    expect(scan.folder).toBe(join(home, "Projects"));
    expect(scan.repositories.map((r) => r.name)).toEqual(["x"]);
  });

  it("rejects missing folders, files and relative paths", async () => {
    const root = tempDir();
    writeFileSync(join(root, "f"), "x");
    await expectCode(scanProjectFolder(join(root, "missing")), "not_found");
    await expectCode(scanProjectFolder(join(root, "f")), "invalid_request");
    await expectCode(scanProjectFolder("rel/path"), "invalid_request");
  });
});
