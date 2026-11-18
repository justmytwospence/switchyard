import type { RuntimeState, Session, View, Workspace } from "./entities.js";
import type { TrackedIssue } from "./trackers.js";
import { sessionInView, type WorkspaceLookup } from "./views.js";

/**
 * Branches: a project on a branch, the unit of work every client lists. Derived from workspaces,
 * sessions and tracked issues; never stored. See docs/model.md.
 */

export const LIVE_RUNTIMES = ["starting", "idle", "running", "waiting_input"] as const;

export function isLiveRuntime(r: RuntimeState): boolean {
  return (LIVE_RUNTIMES as readonly string[]).includes(r);
}

export type BranchStage = "not_started" | "working" | "in_review" | "merged";

export const BRANCH_STAGES: { value: BranchStage; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "working", label: "Working" },
  { value: "in_review", label: "In review" },
  { value: "merged", label: "Merged" },
];

export interface BranchPlacement {
  workspace: Workspace | null;
  hostId: string;
}

export interface Branch {
  key: string;
  /** `scratch`: sessions outside every workspace. */
  kind: "branch" | "scratch";
  projectId: string | null;
  /** Null for a detached worktree or scratch. */
  branch: string | null;
  /** Every placement is a main checkout. */
  main: boolean;
  placements: BranchPlacement[];
  primary: Session | null;
  /** Other top-level sessions, most recently active first. */
  extras: Session[];
  /** Most recently active first. */
  subagents: Session[];
  issue: TrackedIssue | null;
  pullRequest: { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED" } | null;
  stage: Exclude<BranchStage, "not_started">;
  /** Latest of its sessions, else its workspaces' `updatedAt`. */
  lastActivityAt: string;
}

/**
 * The branch a session or workspace belongs to: `b:<projectId>:<branch>` for a branch,
 * `w:<workspaceId>` for a detached worktree, `d:<hostId>:<cwd>` outside every workspace.
 * `perHost` keeps the same branch on two hosts apart.
 */
export function branchKeyOf(
  s: Pick<Session, "hostId" | "cwd" | "workspaceId">,
  ws: Workspace | null | undefined,
  perHost = false,
): string {
  if (ws) {
    if (ws.branch) return `b:${ws.projectId}:${ws.branch}${perHost ? `@${ws.hostId}` : ""}`;
    return `w:${ws.id}`;
  }
  return `d:${s.hostId}:${s.cwd}`;
}

/**
 * The primary of a branch's top-level, non-archived sessions: the chosen one (most recently
 * active if several), else the oldest live one, else the most recently active one.
 */
export function primarySession<
  T extends Pick<Session, "id" | "primary" | "runtime" | "createdAt" | "lastActivityAt">,
>(sessions: T[]): T | null {
  if (sessions.length === 0) return null;
  const byActivity = (a: T, b: T) => b.lastActivityAt.localeCompare(a.lastActivityAt);
  const chosen = sessions.filter((s) => s.primary === true).sort(byActivity);
  if (chosen.length > 0) return chosen[0]!;
  const live = sessions
    .filter((s) => isLiveRuntime(s.runtime))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (live.length > 0) return live[0]!;
  return [...sessions].sort(byActivity)[0]!;
}

/** The latest of ISO timestamps ("" when none). */
function latestOf(times: string[]): string {
  let best = "";
  for (const t of times) if (t > best) best = t;
  return best;
}

interface Acc {
  key: string;
  kind: "branch" | "scratch";
  projectId: string | null;
  branch: string | null;
  workspaces: Workspace[];
  scratchHost: string | null;
  tops: Session[];
  subagents: Session[];
}

/** Every branch with its sessions and issue, plus the issues no branch has yet. */
export function buildBranches(
  input: { workspaces: Workspace[]; sessions: Session[]; issues: TrackedIssue[] },
  opts: { perHost?: boolean } = {},
): { branches: Branch[]; unstarted: TrackedIssue[] } {
  const perHost = opts.perHost ?? false;
  const workspaces = input.workspaces.filter((w) => !w.archivedAt);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const sessions = input.sessions.filter((s) => s.archivedAt === null);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const accs = new Map<string, Acc>();
  const acc = (key: string, init: () => Omit<Acc, "key" | "tops" | "subagents" | "workspaces">) => {
    let a = accs.get(key);
    if (!a) {
      a = { key, ...init(), workspaces: [], tops: [], subagents: [] };
      accs.set(key, a);
    }
    return a;
  };
  for (const w of workspaces) {
    const key = branchKeyOf({ hostId: w.hostId, cwd: w.path, workspaceId: w.id }, w, perHost);
    const a = acc(key, () => ({
      kind: "branch",
      projectId: w.projectId,
      branch: w.branch,
      scratchHost: null,
    }));
    a.workspaces.push(w);
  }
  const keyOfSession = (s: Session): string => {
    const ws = s.workspaceId ? wsById.get(s.workspaceId) : undefined;
    return branchKeyOf(s, ws, perHost);
  };
  for (const s of sessions) {
    let key = keyOfSession(s);
    if (s.provenance === "subagent" && s.parentSessionId) {
      const parent = sessionById.get(s.parentSessionId);
      if (parent) key = keyOfSession(parent);
    }
    const ws = s.workspaceId ? wsById.get(s.workspaceId) : undefined;
    const a = acc(key, () =>
      ws
        ? { kind: "branch", projectId: ws.projectId, branch: ws.branch, scratchHost: null }
        : { kind: "scratch", projectId: s.projectId, branch: null, scratchHost: s.hostId },
    );
    if (s.provenance === "subagent") a.subagents.push(s);
    else a.tops.push(s);
  }

  const byActivity = (a: Session, b: Session) => b.lastActivityAt.localeCompare(a.lastActivityAt);
  const used = new Set<string>();
  const branches: Branch[] = [];
  for (const a of accs.values()) {
    const latestIn = (w: Workspace) =>
      latestOf(
        [...a.tops, ...a.subagents]
          .filter((s) => s.workspaceId === w.id)
          .map((s) => s.lastActivityAt),
      );
    const ws = [...a.workspaces].sort((x, y) => latestIn(y).localeCompare(latestIn(x)));
    const placements: BranchPlacement[] = ws.map((w) => ({ workspace: w, hostId: w.hostId }));
    if (a.kind === "scratch" && a.scratchHost) {
      placements.push({ workspace: null, hostId: a.scratchHost });
    }
    const primary = primarySession(a.tops);
    const extras = a.tops.filter((s) => s !== primary).sort(byActivity);
    const subagents = [...a.subagents].sort(byActivity);
    const wsIds = new Set(ws.map((w) => w.id));
    const issue =
      (a.kind === "branch"
        ? (input.issues.find((i) => i.workspaceId !== null && wsIds.has(i.workspaceId)) ??
          (a.branch
            ? input.issues.find(
                (i) =>
                  i.projectId === a.projectId &&
                  (i.branch === a.branch || i.branches.includes(a.branch!)),
              )
            : undefined))
        : undefined) ?? null;
    if (issue) used.add(issue.id);
    const fromWs = ws.find((w) => w.github?.status === "ready" && w.github.pullRequest)?.github
      ?.pullRequest;
    const pullRequest = fromWs
      ? { number: fromWs.number, url: fromWs.url, state: fromWs.state }
      : issue?.pullRequest
        ? {
            number: issue.pullRequest.number,
            url: issue.pullRequest.url,
            state: issue.pullRequest.state,
          }
        : null;
    const stage =
      pullRequest?.state === "MERGED"
        ? "merged"
        : pullRequest?.state === "OPEN"
          ? "in_review"
          : "working";
    const all = [...a.tops, ...a.subagents];
    const lastActivityAt =
      all.length > 0
        ? latestOf(all.map((s) => s.lastActivityAt))
        : latestOf(ws.map((w) => w.updatedAt));
    branches.push({
      key: a.key,
      kind: a.kind,
      projectId: a.projectId,
      branch: a.branch,
      main: ws.length > 0 && ws.every((w) => w.provenance === "main"),
      placements,
      primary,
      extras,
      subagents,
      issue,
      pullRequest,
      stage,
      lastActivityAt,
    });
  }
  branches.sort((x, y) => y.lastActivityAt.localeCompare(x.lastActivityAt));
  const unstarted = input.issues.filter(
    (i) => !used.has(i.id) && i.pullRequest?.state !== "MERGED",
  );
  return { branches, unstarted };
}

/** Is a branch in a view? By its sessions, else (unless pinned-only) by project and host. */
export function branchInView(view: View, b: Branch, workspaces: WorkspaceLookup): boolean {
  const sessions = [...(b.primary ? [b.primary] : []), ...b.extras];
  if (sessions.some((s) => sessionInView(view, s, workspaces))) return true;
  if (view.mode === "pinned") return false;
  if (view.projectIds !== null && (b.projectId === null || !view.projectIds.includes(b.projectId)))
    return false;
  if (view.hostIds !== null && !b.placements.some((p) => view.hostIds!.includes(p.hostId)))
    return false;
  return true;
}

/** Is an issue in a view? By its project; never in a pinned-only view. */
export function issueInView(view: View, i: Pick<TrackedIssue, "projectId">): boolean {
  if (view.mode === "pinned") return false;
  return view.projectIds === null || view.projectIds.includes(i.projectId);
}
