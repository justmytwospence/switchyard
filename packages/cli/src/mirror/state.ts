import type {
  Checkout,
  Host,
  Project,
  Session,
  Terminal,
  TrackedIssue,
  View,
  Workspace,
} from "@switchyard/protocol";
import { buildBranches, sessionInView, trackerScope } from "@switchyard/protocol";
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
  views: View[];
  /** Tracked issues (decide a tracker view's sessions); absent in older fixtures. */
  issues?: TrackedIssue[];
  /** Terminals and their recorded bindings; absent in older fixtures. */
  terminals?: Terminal[];
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
    views: Object.values(s.views),
    issues: Object.values(s.issues ?? {}),
    terminals: Object.values(s.terminals ?? {}),
  };
}

/** `mirroredSessions` limited to a view (all of them without one). */
export function viewedSessions(st: MirrorState, view: View | null): Session[] {
  const all = mirroredSessions(st);
  if (!view) return all;
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const scope = trackerScope(view, st.issues ?? []);
  return all.filter((s) => sessionInView(view, s, workspaces, scope));
}

/** A stopped session counts as active for this long after its last activity. */
export const RECENT_MS = 48 * 60 * 60_000;

/** The terminal a session's Pi runs in by hand (an own pane), if any. */
export function placedIn(s: Pick<Session, "external">): string | null {
  return s.external?.client ?? null;
}

/**
 * Active: live (including waiting for input), unread, or active in the last 48 hours. Only active
 * branches get a tab opened for them. A pin is membership in a view only, not activity.
 */
export function isActive(s: Session, now: number): boolean {
  return (
    LIVE_RUNTIMES.includes(s.runtime) ||
    !!s.unreadSince ||
    now - Date.parse(s.lastActivityAt) < RECENT_MS
  );
}

/**
 * The sessions a mirror opens a tab or window for: one per active branch in the view (its primary,
 * or its latest session the view holds when the primary is not in it); oldest first. Extras are opened on demand (the picker), and a session whose Pi runs by
 * hand in `terminalId` (an own pane there) gets none.
 */
export function wantedSessions(
  st: MirrorState,
  view: View | null,
  now: number,
  terminalId: string | null = null,
): Session[] {
  const kept = new Map(viewedSessions(st, view).map((s) => [s.id, s]));
  const { branches } = buildBranches({
    workspaces: st.workspaces,
    sessions: st.sessions,
    issues: [],
  });
  const out = new Map<string, Session>();
  const add = (id: string | undefined) => {
    const s = id ? kept.get(id) : undefined;
    if (!s || (terminalId && placedIn(s) === terminalId)) return;
    if (isActive(s, now)) out.set(s.id, s);
  };
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const scope = view ? trackerScope(view, st.issues ?? []) : null;
  const inView = (x: Session) => !view || sessionInView(view, x, workspaces, scope);
  for (const b of branches) {
    // The primary; when the view holds only other sessions of the branch (pins), its latest one.
    const rep = b.primary && inView(b.primary) ? b.primary : b.extras.find(inView);
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

/** Sessions that left a tracker's view only by stopping: a focused tab or window of theirs stays until focus moves. */
export function lingeringSessions(st: MirrorState, view: View | null): Set<string> {
  const out = new Set<string>();
  if (!view?.trackerId) return out;
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  const scope = trackerScope(view, st.issues ?? []);
  for (const s of mirroredSessions(st)) {
    if (sessionInView(view, s, workspaces, scope)) continue;
    if (sessionInView(view, { ...s, runtime: "idle" }, workspaces, scope)) out.add(s.id);
  }
  return out;
}
