import type {
  Checkout,
  Client,
  Host,
  Project,
  Scope,
  Session,
  TrackedIssue,
  Workspace,
} from "@switchyard/protocol";
import { buildBranches, issueBranchSet, sessionInScope } from "@switchyard/protocol";
import { SwitchyardClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags, resolveConnection } from "../config.js";
import type { Ctx } from "../context.js";

/** How long a typed pane command may take to claim its pane before we try again. */
export const PENDING_MS = 15_000;
/** A new session gets this long to be claimed by the tab that created it (the picker). */
export const NEW_SESSION_GRACE_MS = 5_000;
export interface MirrorState {
  sessions: Session[];
  workspaces: Workspace[];
  projects: Project[];
  hosts: Host[];
  checkouts: Checkout[];
  scopes: Scope[];
  /** Tracked issues (decide a GitHub scope's sessions); absent in older fixtures. */
  issues?: TrackedIssue[];
  /** Clients and their recorded bindings; absent in older fixtures. */
  clients?: Client[];
}

export type AgentState = "idle" | "working" | "blocked";

export const LIVE_RUNTIMES: Session["runtime"][] = ["starting", "idle", "running", "waiting_input"];

/**
 * Sessions with a tab: not archived, not read-only subagent views, and with a Pi terminal now or
 * when resumed (their host runs terminal sessions, and they are not running headless); oldest
 * first. A starting session counts: its terminal flag is set once it has started.
 */
export function mirroredSessions(st: MirrorState): Session[] {
  const terminalHosts = new Set(
    st.hosts.filter((h) => h.capabilities?.terminal === true).map((h) => h.id),
  );
  return st.sessions
    .filter((s) => s.archivedAt === null && !s.readOnly && terminalHosts.has(s.hostId))
    .filter(
      (s) => s.runtime === "starting" || !LIVE_RUNTIMES.includes(s.runtime) || s.terminal === true,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function agentState(runtime: Session["runtime"]): AgentState {
  if (runtime === "running" || runtime === "starting") return "working";
  if (runtime === "waiting_input") return "blocked";
  return "idle";
}

/** Connect a live client and read the mirror's view of Switchyard. */
export async function loadMirrorState(
  ctx: Ctx,
  flags: ConnectionFlags,
  timeoutMs = 15_000,
): Promise<{ client: SwitchyardClient; state: () => MirrorState }> {
  const conn = resolveConnection(flags, ctx.env, ctx.paths);
  const client = new SwitchyardClient({ coordinatorUrl: conn.url, credential: conn.credential });
  client.connect();
  await new Promise<void>((resolve, reject) => {
    if (client.store.getState().synced) return resolve();
    const timer = setTimeout(() => {
      off();
      client.close();
      reject(new CliError("Switchyard is not reachable"));
    }, timeoutMs);
    const off = client.onLive(() => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  return { client, state: () => mirrorStateOf(client) };
}

export function mirrorStateOf(client: SwitchyardClient): MirrorState {
  const s = client.store.getState();
  return {
    sessions: Object.values(s.sessions),
    workspaces: Object.values(s.workspaces),
    projects: Object.values(s.projects),
    hosts: Object.values(s.hosts),
    checkouts: Object.values(s.checkouts),
    scopes: Object.values(s.scopes),
    issues: Object.values(s.issues ?? {}),
    clients: Object.values(s.clients ?? {}),
  };
}

/** `mirroredSessions` limited to a scope (all of them without one). */
export function scopedSessions(st: MirrorState, scope: Scope | null): Session[] {
  const all = mirroredSessions(st);
  if (!scope) return all;
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const issueSet = issueBranchSet(scope, st.issues ?? []);
  return all.filter((s) => sessionInScope(scope, s, workspaces, issueSet));
}

/** A stopped session counts as active for this long after its last activity. */
export const RECENT_MS = 48 * 60 * 60_000;

/** The client a session's Pi runs, or last ran, in by hand (an own pane), if any. */
export function placedIn(s: Pick<Session, "external" | "place">): string | null {
  return s.place?.terminalId ?? s.external?.client ?? null;
}

/** The live session whose Pi runs by hand in this client's `pane`, if any. */
export function paneSession(
  st: Pick<MirrorState, "sessions">,
  clientId: string,
  pane: string,
): string | null {
  const s = st.sessions.find(
    (x) =>
      x.archivedAt === null &&
      x.external?.client === clientId &&
      x.place?.pane === pane &&
      LIVE_RUNTIMES.includes(x.runtime),
  );
  return s?.id ?? null;
}

/**
 * Active: live (including waiting for input), unread, or active in the last 48 hours. Only active
 * branches get a tab opened for them. A pin is membership in a scope only, not activity.
 */
export function isActive(s: Session, now: number): boolean {
  return (
    LIVE_RUNTIMES.includes(s.runtime) ||
    !!s.unreadSince ||
    now - Date.parse(s.lastActivityAt) < RECENT_MS
  );
}

/**
 * The sessions a mirror opens a tab or window for: one per active branch in the scope (its primary,
 * or its latest session the scope holds when the primary is not in it); oldest first. Extras are opened on demand (the picker), and a session whose Pi runs by
 * hand in `clientId` (an own pane there) gets none.
 */
export function wantedSessions(
  st: MirrorState,
  scope: Scope | null,
  now: number,
  clientId: string | null = null,
): Session[] {
  const kept = new Map(scopedSessions(st, scope).map((s) => [s.id, s]));
  const { branches } = buildBranches({
    workspaces: st.workspaces,
    sessions: st.sessions,
    issues: [],
  });
  const out = new Map<string, Session>();
  const add = (id: string | undefined) => {
    const s = id ? kept.get(id) : undefined;
    if (!s || (clientId && placedIn(s) === clientId)) return;
    if (isActive(s, now)) out.set(s.id, s);
  };
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const issueSet = scope ? issueBranchSet(scope, st.issues ?? []) : null;
  const inScope = (x: Session) => !scope || sessionInScope(scope, x, workspaces, issueSet);
  for (const b of branches) {
    // The primary; when the scope holds only other sessions of the branch (pins), its latest one.
    const rep = b.primary && inScope(b.primary) ? b.primary : b.extras.find(inScope);
    add(rep?.id);
  }
  return [...out.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Each branch's primary session: closing its tab archives it; closing an extra's only hides it. */
export function primaryIds(st: MirrorState): Set<string> {
  const { branches } = buildBranches({
    workspaces: st.workspaces,
    sessions: st.sessions,
    issues: [],
  });
  return new Set(branches.flatMap((b) => (b.primary ? [b.primary.id] : [])));
}

/** Sessions that left a GitHub scope only by stopping: a focused tab or window of theirs stays until focus moves. */
export function lingeringSessions(st: MirrorState, scope: Scope | null): Set<string> {
  const out = new Set<string>();
  if (!scope?.source) return out;
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const issueSet = issueBranchSet(scope, st.issues ?? []);
  for (const s of mirroredSessions(st)) {
    if (sessionInScope(scope, s, workspaces, issueSet)) continue;
    if (sessionInScope(scope, { ...s, runtime: "idle" }, workspaces, issueSet)) out.add(s.id);
  }
  return out;
}
