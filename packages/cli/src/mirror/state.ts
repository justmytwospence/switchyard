import type { Checkout, Host, Project, Session, View, Workspace } from "@switchyard/protocol";
import { findView, sessionInView } from "@switchyard/protocol";
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
  };
}

/** `mirroredSessions` limited to a view (all of them without one). */
export function viewedSessions(st: MirrorState, view: View | null): Session[] {
  const all = mirroredSessions(st);
  if (!view) return all;
  const workspaces = Object.fromEntries(st.workspaces.map((w) => [w.id, w]));
  return all.filter((s) => sessionInView(view, s, workspaces));
}

/** The view a client is bound to by name or id; unbound mirrors everything. */
export function resolveBoundView(
  st: Pick<MirrorState, "views">,
  ref: string | undefined,
): { view: View | null; missing: boolean } {
  if (!ref) return { view: null, missing: false };
  const view = findView(st.views, ref);
  return view ? { view, missing: false } : { view: null, missing: true };
}
