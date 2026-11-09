import type { Workspace, WorkspaceGitHub } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../src/features/code/hooks";
import { GitHubStatus, PullRequest } from "../src/features/code/PullRequest";
import type { PullRequestState } from "../src/features/code/usePullRequest";
import { session } from "./fixtures";
import { check, snapshot as legacySnapshot, NOW } from "./github-fixtures";

function snapshot(patch: Partial<WorkspaceGitHub> = {}): WorkspaceGitHub {
  const value = legacySnapshot();
  value.pullRequest!.nodeId = "PR_node";
  return Object.assign(value, patch);
}

function context(patch: Partial<SessionContext> = {}): SessionContext {
  return {
    session: session("s"),
    workspace: { id: "w", branch: "topic", archivedAt: null } as Workspace,
    host: undefined,
    hostName: "host",
    link: "connected",
    project: undefined,
    run: null,
    task: undefined,
    control: "none",
    adapters: [],
    ...patch,
  };
}
function state(patch: Partial<PullRequestState> = {}): PullRequestState {
  return {
    snapshot: snapshot(),
    github: { available: true, reason: null },
    pageVisible: true,
    mergeUncertain: false,
    markMergeUncertain: vi.fn(),
    error: null,
    loading: false,
    refresh: vi.fn().mockResolvedValue(null),
    reload: vi.fn().mockResolvedValue(null),
    ...patch,
  };
}
function render(s = state(), ctx = context()) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PullRequest ctx={ctx} state={s} active />
    </MemoryRouter>,
  );
}
function mergeDisabled(html: string) {
  return /<button[^>]*disabled=""[^>]*>Squash merge<\/button>/.test(html);
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

describe("PR inspector rendering", () => {
  it("shows full reviewed SHA, checks/links, thread file/line/author and outdated marker", () => {
    const html = render();
    expect(html).toContain("A useful change");
    expect(html).toContain("a".repeat(40));
    expect(html).toContain("src/file.ts:17 (RIGHT) · Outdated");
    expect(html).toContain("reviewer");
    expect(html).toContain("Fix this edge case.");
    expect(html).toContain('href="https://github.com/owner/repo/actions/runs/12/job/34"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(mergeDisabled(html)).toBe(false);
    expect(html).toContain("Merging never accepts the task");
  });
  it("uses Markdown sanitization, not executable review HTML or scripts", () => {
    const s = state();
    s.snapshot!.threads[0]!.comments[0]!.body =
      "<script>alert(1)</script>\n\n[sneaky](javascript:alert(1))\n\n**Bold comment**";
    const html = render(s);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("<strong>Bold comment</strong>");
  });
  it("keeps discovery/Refresh available before a conditional PR tab can exist", () => {
    for (const s of [
      state({ snapshot: null, github: null }),
      state({ snapshot: snapshot({ pullRequest: null, checks: [], threads: [] }) }),
      state({ snapshot: null, github: { available: false, reason: "Sign in with gh" } }),
    ]) {
      const html = renderToStaticMarkup(<GitHubStatus ctx={context()} state={s} />);
      expect(html).toContain("Refresh");
      expect(html).not.toContain("Open PR");
    }
    expect(
      render(state({ snapshot: snapshot({ pullRequest: null, checks: [], threads: [] }) })),
    ).toContain("No pull request is associated");
    expect(render(state({ snapshot: null, github: null }))).toContain("unsupported on this host");
  });
  it.each([
    state({
      snapshot: snapshot({ checksComplete: false, threadsComplete: false, truncated: true }),
    }),
    state({
      snapshot: snapshot({
        status: "error",
        reason: "Network failed",
        checksComplete: false,
        threadsComplete: false,
      }),
    }),
    state({ snapshot: snapshot({ fetchedAt: new Date(NOW - 60_000).toISOString() }) }),
    state({ snapshot: snapshot({ checks: [check({ bucket: "unknown" })] }) }),
    state({ error: "Policy refused this action" }),
    state({ loading: true }),
    state({ mergeUncertain: true }),
  ])("retains useful data but disables merge for stale/incomplete/errors/pending requests", (s) => {
    const html = render(s);
    expect(html).toContain("A useful change");
    expect(mergeDisabled(html)).toBe(true);
  });
  it("labels stale no-PR snapshots and offline caches instead of presenting a fresh absence", () => {
    const html = render(
      state({
        snapshot: snapshot({
          pullRequest: null,
          checks: [],
          threads: [],
          fetchedAt: new Date(NOW - 120_000).toISOString(),
        }),
      }),
    );
    expect(html).toContain("No pull request is associated");
    expect(html).toContain("Stale");
    expect(html).toContain("Attempted");
    expect(render(state(), context({ link: "unreachable" }))).toContain("Host offline");
  });
  it("invalidates actions when the workspace branch changes independently of a cached snapshot", () => {
    const ctx = context();
    ctx.workspace = { ...ctx.workspace!, branch: "another-branch" };
    const html = render(state(), ctx);
    expect(mergeDisabled(html)).toBe(true);
    expect(html).toContain("Workspace branch changed");
  });
  it("does not misrepresent incomplete empty lists as confirmed empty", () => {
    const html = render(
      state({
        snapshot: snapshot({
          checks: [],
          threads: [],
          checksComplete: false,
          threadsComplete: false,
        }),
      }),
    );
    expect(html).toContain("Checks are unavailable, not confirmed empty");
    expect(html).toContain("Review threads are unavailable, not confirmed empty");
    expect(html).toContain("Partial data");
  });
  it("disables actions for offline, archived and read-only sessions", () => {
    for (const ctx of [
      context({ link: "unreachable" }),
      context({ session: session("s", { readOnly: true }) }),
      context({ session: session("s", { archivedAt: new Date(NOW).toISOString() }) }),
    ]) {
      const html = render(state(), ctx);
      expect(mergeDisabled(html)).toBe(true);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Resolve review comments<\/button>/);
    }
  });
});
