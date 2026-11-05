import type { Session, View, ViewClient, Workspace } from "./entities.js";

/** A client counts as open in a view while its last report is younger than this. */
export const CLIENT_OPEN_MS = 10 * 60_000;

type WorkspaceLookup =
  | Record<string, Pick<Workspace, "projectId">>
  | Map<string, Pick<Workspace, "projectId">>;

function workspaceOf(ws: WorkspaceLookup, id: string) {
  return ws instanceof Map ? ws.get(id) : ws[id];
}

/** Is a session in a view? Archived sessions never are. */
export function sessionInView(
  view: View,
  s: Pick<Session, "id" | "projectId" | "workspaceId" | "hostId" | "archivedAt">,
  workspaces: WorkspaceLookup,
): boolean {
  if (s.archivedAt !== null) return false;
  if (view.sessionIds.includes(s.id)) return true;
  if (view.mode === "pinned") return false;
  const projectId =
    s.projectId ??
    (s.workspaceId ? workspaceOf(workspaces, s.workspaceId)?.projectId : null) ??
    null;
  if (view.projectIds !== null && (projectId === null || !view.projectIds.includes(projectId))) {
    return false;
  }
  if (view.hostIds !== null && !view.hostIds.includes(s.hostId)) return false;
  return true;
}

/** Clients that reported recently, sorted by kind then name. */
export function openClients(view: View, now = Date.now()): ViewClient[] {
  return view.clients
    .filter((c) => now - Date.parse(c.lastSeenAt) < CLIENT_OPEN_MS)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Resolve a view by id, else by case-insensitive name; null if absent or ambiguous. */
export function findView(views: View[], ref: string): View | null {
  const byId = views.find((v) => v.id === ref);
  if (byId) return byId;
  const named = views.filter((v) => v.name.toLowerCase() === ref.toLowerCase());
  return named.length === 1 ? named[0]! : null;
}
