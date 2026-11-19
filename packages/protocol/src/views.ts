import type { RuntimeState, Session, Surface, Task, View, Workspace } from "./entities.js";
import type { TrackedIssue } from "./trackers.js";

/** A surface counts as open while its last report is younger than this. */
export const SURFACE_OPEN_MS = 10 * 60_000;

export const LIVE_RUNTIMES = ["starting", "idle", "running", "waiting_input"] as const;

export function isLiveRuntime(r: RuntimeState): boolean {
  return (LIVE_RUNTIMES as readonly string[]).includes(r);
}

type WorkspaceRef = Pick<Workspace, "projectId"> & { branch?: string | null };

export type WorkspaceLookup = Record<string, WorkspaceRef> | Map<string, WorkspaceRef>;

/** The branches a tracker's issues are worked on: what a tracker's view holds besides live sessions. */
export interface TrackerScope {
  trackerId: string;
  workspaceIds: Set<string>;
  /** `${projectId}\n${branch}` */
  branches: Set<string>;
}

export function trackerScope(
  view: Pick<View, "trackerId">,
  issues: Iterable<
    Pick<TrackedIssue, "trackerId" | "projectId" | "workspaceId" | "branch" | "branches">
  >,
): TrackerScope | null {
  if (!view.trackerId) return null;
  const scope: TrackerScope = {
    trackerId: view.trackerId,
    workspaceIds: new Set(),
    branches: new Set(),
  };
  for (const i of issues) {
    if (i.trackerId !== view.trackerId) continue;
    if (i.workspaceId) scope.workspaceIds.add(i.workspaceId);
    if (i.branch) scope.branches.add(`${i.projectId}\n${i.branch}`);
    for (const b of i.branches) scope.branches.add(`${i.projectId}\n${b}`);
  }
  return scope;
}

/** Is this workspace one of the tracker's issue branches (by worktree or branch name)? */
export function scopeHasWorkspace(
  scope: TrackerScope,
  ws: { id: string; projectId: string; branch?: string | null },
): boolean {
  return (
    scope.workspaceIds.has(ws.id) ||
    (!!ws.branch && scope.branches.has(`${ws.projectId}\n${ws.branch}`))
  );
}

function workspaceOf(ws: WorkspaceLookup, id: string) {
  return ws instanceof Map ? ws.get(id) : ws[id];
}

/** Why a session is in a view: pinned, started in its source, on a tracker's issue, live, or by the filters. */
export type ViewReason = "pinned" | "client" | "issue" | "live" | "filter";

type ViewSession = Pick<
  Session,
  "id" | "projectId" | "workspaceId" | "hostId" | "archivedAt" | "startedIn" | "runtime"
>;

/** Why a session is in a view; null when it is not. See `sessionInView`. */
export function sessionViewReason(
  view: View,
  s: ViewSession,
  workspaces: WorkspaceLookup,
  scope?: TrackerScope | null,
): ViewReason | null {
  if (s.archivedAt !== null) return null;
  if (view.sessionIds.includes(s.id)) return "pinned";
  if (view.clientId && s.startedIn === view.clientId) return "client";
  if (view.mode === "pinned") return null;
  const projectId =
    s.projectId ??
    (s.workspaceId ? workspaceOf(workspaces, s.workspaceId)?.projectId : null) ??
    null;
  if (view.projectIds !== null && (projectId === null || !view.projectIds.includes(projectId))) {
    return null;
  }
  if (view.hostIds !== null && !view.hostIds.includes(s.hostId)) return null;
  if (view.trackerId && scope) {
    if (s.workspaceId) {
      if (scope.workspaceIds.has(s.workspaceId)) return "issue";
      const ws = workspaceOf(workspaces, s.workspaceId);
      if (ws?.branch && scope.branches.has(`${ws.projectId}\n${ws.branch}`)) return "issue";
    }
    return isLiveRuntime(s.runtime) ? "live" : null;
  }
  return "filter";
}

/**
 * Is a session in a view? Archived sessions never are. In a tracker's view (given its scope):
 * sessions on its issues' branches, and live sessions in its projects.
 */
export function sessionInView(
  view: View,
  s: ViewSession,
  workspaces: WorkspaceLookup,
  scope?: TrackerScope | null,
): boolean {
  return sessionViewReason(view, s, workspaces, scope) !== null;
}

/** Surfaces showing a view that reported recently, sorted by kind then name. */
export function openSurfaces(surfaces: Surface[], viewId: string, now = Date.now()): Surface[] {
  return surfaces
    .filter((c) => c.viewId === viewId && now - Date.parse(c.lastSeenAt) < SURFACE_OPEN_MS)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Resolve a view by id, else by case-insensitive name; null if absent or ambiguous. */
export function findView(views: View[], ref: string): View | null {
  const byId = views.find((v) => v.id === ref);
  if (byId) return byId;
  const named = views.filter((v) => v.name.toLowerCase() === ref.toLowerCase());
  return named.length === 1 ? named[0]! : null;
}

/** Is a task in a view? By its project, or because its session is pinned. Host filters do not apply to tasks. */
export function taskInView(view: View, t: Pick<Task, "projectId" | "sessionId">): boolean {
  if (t.sessionId !== null && view.sessionIds.includes(t.sessionId)) return true;
  if (view.mode === "pinned") return false;
  return view.projectIds === null || view.projectIds.includes(t.projectId);
}
