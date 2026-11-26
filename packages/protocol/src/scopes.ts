import type { Client, RuntimeState, Scope, Session, Task, Workspace } from "./entities.js";
import type { TrackedIssue } from "./issues.js";

/** A client counts as open while its last report is younger than this. */
export const CLIENT_OPEN_MS = 10 * 60_000;

export const LIVE_RUNTIMES = ["starting", "idle", "running", "waiting_input"] as const;

export function isLiveRuntime(r: RuntimeState): boolean {
  return (LIVE_RUNTIMES as readonly string[]).includes(r);
}

type WorkspaceRef = Pick<Workspace, "projectId"> & { branch?: string | null };

export type WorkspaceLookup = Record<string, WorkspaceRef> | Map<string, WorkspaceRef>;

/** The branches a scope's issues are worked on: what a GitHub scope holds besides live sessions. */
export interface IssueBranchSet {
  scopeId: string;
  workspaceIds: Set<string>;
  /** `${projectId}\n${branch}` */
  branches: Set<string>;
}

/** The issue branches of a scope with a source; null for a scope of projects you choose. */
export function issueBranchSet(
  scope: Pick<Scope, "id" | "source">,
  issues: Iterable<
    Pick<TrackedIssue, "scopeId" | "projectId" | "workspaceId" | "branch" | "branches">
  >,
): IssueBranchSet | null {
  if (!scope.source) return null;
  const set: IssueBranchSet = {
    scopeId: scope.id,
    workspaceIds: new Set(),
    branches: new Set(),
  };
  for (const i of issues) {
    if (i.scopeId !== scope.id) continue;
    if (i.workspaceId) set.workspaceIds.add(i.workspaceId);
    if (i.branch) set.branches.add(`${i.projectId}\n${i.branch}`);
    for (const b of i.branches) set.branches.add(`${i.projectId}\n${b}`);
  }
  return set;
}

/** Is this workspace one of the scope's issue branches (by worktree or branch name)? */
export function issueBranchSetHas(
  issueSet: IssueBranchSet,
  ws: { id: string; projectId: string; branch?: string | null },
): boolean {
  return (
    issueSet.workspaceIds.has(ws.id) ||
    (!!ws.branch && issueSet.branches.has(`${ws.projectId}\n${ws.branch}`))
  );
}

function workspaceOf(ws: WorkspaceLookup, id: string) {
  return ws instanceof Map ? ws.get(id) : ws[id];
}

/** Why a session is in a scope: pinned, on one of its issues, live, or by the filters. */
export type ScopeReason = "pinned" | "issue" | "live" | "filter";

type ScopeSession = Pick<
  Session,
  "id" | "projectId" | "workspaceId" | "hostId" | "archivedAt" | "runtime"
>;

/** Why a session is in a scope; null when it is not. See `sessionInScope`. */
export function sessionScopeReason(
  scope: Scope,
  s: ScopeSession,
  workspaces: WorkspaceLookup,
  issueSet?: IssueBranchSet | null,
): ScopeReason | null {
  if (s.archivedAt !== null) return null;
  if (scope.sessionIds.includes(s.id)) return "pinned";
  if (scope.mode === "pinned") return null;
  const projectId =
    s.projectId ??
    (s.workspaceId ? workspaceOf(workspaces, s.workspaceId)?.projectId : null) ??
    null;
  if (scope.projectIds !== null && (projectId === null || !scope.projectIds.includes(projectId))) {
    return null;
  }
  if (scope.hostIds !== null && !scope.hostIds.includes(s.hostId)) return null;
  if (scope.source && issueSet) {
    if (s.workspaceId) {
      if (issueSet.workspaceIds.has(s.workspaceId)) return "issue";
      const ws = workspaceOf(workspaces, s.workspaceId);
      if (ws?.branch && issueSet.branches.has(`${ws.projectId}\n${ws.branch}`)) return "issue";
    }
    return isLiveRuntime(s.runtime) ? "live" : null;
  }
  return "filter";
}

/**
 * Is a session in a scope? Archived sessions never are. In a GitHub scope (given its issue
 * branches): sessions on its issues' branches, and live sessions in its projects.
 */
export function sessionInScope(
  scope: Scope,
  s: ScopeSession,
  workspaces: WorkspaceLookup,
  issueSet?: IssueBranchSet | null,
): boolean {
  return sessionScopeReason(scope, s, workspaces, issueSet) !== null;
}

/** Whether a client reported recently (its daemon runs). */
export function clientOpen(c: Pick<Client, "lastSeenAt">, now = Date.now()): boolean {
  return now - Date.parse(c.lastSeenAt) < CLIENT_OPEN_MS;
}

/** Open clients mirroring a scope, sorted by kind then name. */
export function openClients(clients: Client[], scopeId: string, now = Date.now()): Client[] {
  return clients
    .filter((c) => c.mirror === "scope" && c.scopeId === scopeId && clientOpen(c, now))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Resolve a scope by id, else by case-insensitive name; null if absent or ambiguous. */
export function findScope(scopes: Scope[], ref: string): Scope | null {
  const byId = scopes.find((v) => v.id === ref);
  if (byId) return byId;
  const named = scopes.filter((v) => v.name.toLowerCase() === ref.toLowerCase());
  return named.length === 1 ? named[0]! : null;
}

/** Is a task in a scope? By its project, or because its session is pinned. Host filters do not apply to tasks. */
export function taskInScope(scope: Scope, t: Pick<Task, "projectId" | "sessionId">): boolean {
  if (t.sessionId !== null && scope.sessionIds.includes(t.sessionId)) return true;
  if (scope.mode === "pinned") return false;
  return scope.projectIds === null || scope.projectIds.includes(t.projectId);
}
