import type { GitCommit, LogResult } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  commitMeta,
  commitsHeading,
  emptyScopeText,
  scopeLabel,
  scopeRev,
} from "../src/features/code/commits";

const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
  sha: SHA,
  subject: "feat: thing",
  author: "Spencer",
  authoredAt: "2026-11-17T10:00:00Z",
  pushed: true,
  ...over,
});
const log = (over: Partial<LogResult> = {}): LogResult => ({
  base: "main",
  scope: "branch",
  commits: [commit(), commit()],
  truncated: false,
  uncommitted: 0,
  ...over,
});

describe("commit scope", () => {
  it("maps scopes to revs and labels", () => {
    expect(scopeRev("all")).toBeUndefined();
    expect(scopeRev("uncommitted")).toBe("uncommitted");
    expect(scopeRev(SHA)).toBe(SHA);
    expect(scopeLabel("all", "main")).toBe("Against main");
    expect(scopeLabel("all", null)).toBe("");
    expect(scopeLabel("uncommitted", "HEAD")).toBe("Uncommitted changes");
    expect(scopeLabel(SHA, "x")).toBe("Commit abcdef1");
  });

  it("titles the list", () => {
    expect(commitsHeading(log())).toBe("Commits on this branch (2)");
    expect(commitsHeading(log({ truncated: true }))).toBe("Commits on this branch (2+)");
    expect(commitsHeading(log({ scope: "recent" }))).toBe("Recent commits");
  });

  it("describes a commit", () => {
    expect(commitMeta(commit(), NOW)).toMatch(/^abcdef1 · Spencer · .+$/);
    expect(commitMeta(commit(), NOW)).not.toContain("not pushed");
    expect(commitMeta(commit({ pushed: false }), NOW)).toMatch(/ · not pushed$/);
  });

  it("explains an empty scope", () => {
    expect(emptyScopeText("all", "main")).toEqual({
      title: "No changes yet",
      description: "Nothing differs from main in this workspace.",
    });
    expect(emptyScopeText("uncommitted", "HEAD").title).toBe("Nothing uncommitted");
    expect(emptyScopeText(SHA, "x").title).toBe("No file changes");
  });
});
