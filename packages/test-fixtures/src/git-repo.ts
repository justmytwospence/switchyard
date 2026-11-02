import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  path: string;
  cleanup(): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Switchyard Test",
      GIT_AUTHOR_EMAIL: "test@switchyard.invalid",
      GIT_COMMITTER_NAME: "Switchyard Test",
      GIT_COMMITTER_EMAIL: "test@switchyard.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** A temporary git repository with one commit on `main`, optionally with an `origin` remote. */
export function makeRepo(opts: { remote?: string } = {}): TempRepo {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-repo-")));
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.name", "Switchyard Test"]);
  git(path, ["config", "user.email", "test@switchyard.invalid"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(path, "README.md"), "# test repo\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-q", "-m", "initial commit"]);
  if (opts.remote) git(path, ["remote", "add", "origin", opts.remote]);
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
