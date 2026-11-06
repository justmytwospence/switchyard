import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, type TempRepo } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { suggestProjects } from "../src/project-suggestions.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sy-sug-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function repo(): TempRepo {
  const r = makeRepo();
  cleanups.push(r.cleanup);
  return r;
}

let n = 0;
function session(root: string, cwd: string, ageHours = 1) {
  const dir = join(root, "slug");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `s${n++}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "session", id: `i${n}`, cwd })}\n`);
  const t = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(f, t, t);
}

describe("suggestProjects", () => {
  it("counts worktree sessions toward the main repository and skips non-repos", async () => {
    const sessions = tmp();
    const home = tmp();
    const r = repo();
    const wt = join(r.path, ".worktrees", "feat");
    execFileSync("git", ["worktree", "add", "-b", "feat", wt], { cwd: r.path, stdio: "ignore" });
    session(sessions, r.path);
    session(sessions, wt);
    session(sessions, wt);
    session(sessions, tmp());
    session(sessions, "/missing/dir");
    session(sessions, "/");
    session(sessions, home);
    const out = await suggestProjects(sessions, { days: 30, home });
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]).toMatchObject({ rootPath: realpathSync(r.path), sessionCount: 3 });
  });

  it("orders by count then recency and caps at 20", async () => {
    const sessions = tmp();
    const a = repo();
    const b = repo();
    session(sessions, a.path, 5);
    session(sessions, b.path, 1);
    session(sessions, b.path, 2);
    const out = await suggestProjects(sessions, { days: 30 });
    expect(out.suggestions.map((s) => s.sessionCount)).toEqual([2, 1]);
    const many = tmp();
    for (let i = 0; i < 22; i++) session(many, repo().path);
    expect((await suggestProjects(many, { days: 30 })).suggestions).toHaveLength(20);
  });
});
