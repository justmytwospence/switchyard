import { basename } from "node:path";
import type { Scope, Session } from "@switchyard/protocol";
import {
  lingeringSessions,
  type MirrorState,
  NEW_SESSION_GRACE_MS,
  PENDING_MS,
  scopedSessions,
  wantedSessions,
} from "../mirror/state.js";

export const WINDOW_OPTION = "@switchyard_session";
const LABEL_MAX = 40;
const SHELLS = ["sh", "bash", "zsh", "fish", "dash"];

export interface TmuxWindow {
  windowId: string;
  name: string;
  sessionId: string | null;
  paneId: string;
  paneDead: boolean;
  paneCommand: string;
  /** The tmux session's current window. */
  active?: boolean;
}

export interface TmuxMemory {
  /** window id -> session id, for windows the mirror created (persisted). */
  ownWindows: Record<string, string>;
  pending: Record<string, { windowId: string; at: number }>;
  offered: Set<string>;
  /** Windows that appeared (`%window-add`) after the daemon started. */
  added: Set<string>;
  titleOverrides: Record<string, string>;
  /** session id -> its `lastActivityAt` when you closed its window: not reopened until it changes. */
  hidden: Record<string, string>;
}

export interface TmuxPlan {
  closeWindows: { windowId: string; sessionId: string }[];
  createWindows: { sessionId: string; name: string; cwd: string | null }[];
  respawns: { paneId: string; sessionId: string }[];
  renames: { windowId: string; name: string }[];
  offers: { windowId: string; paneId: string }[];
}

export function emptyTmuxMemory(): TmuxMemory {
  return {
    ownWindows: {},
    pending: {},
    offered: new Set(),
    added: new Set(),
    titleOverrides: {},
    hidden: {},
  };
}

function cap(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

function prefixOf(s: Session, st: MirrorState): string {
  const project = s.projectId ? st.projects.find((p) => p.id === s.projectId)?.name : undefined;
  return project ?? basename(s.cwd);
}

/** `<project> · <title>`, at most 40 characters. */
export function windowName(
  s: Session,
  st: MirrorState,
  overrides: Record<string, string> = {},
): string {
  return cap(`${prefixOf(s, st)} · ${overrides[s.id] ?? s.title}`);
}

/** The session title a window name stands for: the name without its `<project> · ` prefix. */
export function titleFromWindowName(name: string, s: Session, st: MirrorState): string {
  const prefix = `${prefixOf(s, st)} · `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Compare Switchyard with the paired tmux session and say what to change. Pure. Windows are
 * opened for `wantedSessions` (active branches); a window showing any other session in the scope
 * stays while it exists, unless the mirror opened it and its branch is no longer active.
 */
export function planTmux(
  st: MirrorState,
  scope: Scope | null,
  windows: TmuxWindow[],
  mem: TmuxMemory,
  now: number,
  clientId: string | null = null,
): TmuxPlan {
  const plan: TmuxPlan = {
    closeWindows: [],
    createWindows: [],
    respawns: [],
    renames: [],
    offers: [],
  };
  const M = new Map(scopedSessions(st, scope).map((s) => [s.id, s]));
  const W = new Map(wantedSessions(st, scope, now, clientId).map((s) => [s.id, s]));
  const linger = lingeringSessions(st, scope);
  const claimed = new Set<string>();
  for (const w of windows) {
    if (!w.sessionId) continue;
    claimed.add(w.sessionId);
    const s = M.get(w.sessionId);
    // A window the mirror opened goes once its branch is no longer active; one you opened stays.
    const inactive = !!s && !W.has(s.id) && mem.ownWindows[w.windowId] === s.id;
    if (!s || inactive) {
      // A session that stopped out of the scope or went inactive keeps the window you are in until you leave it.
      if (w.active && (inactive || linger.has(w.sessionId))) continue;
      plan.closeWindows.push({ windowId: w.windowId, sessionId: w.sessionId });
      continue;
    }
    if (w.paneDead) plan.respawns.push({ paneId: w.paneId, sessionId: s.id });
    const name = windowName(s, st, mem.titleOverrides);
    if (w.name !== name) plan.renames.push({ windowId: w.windowId, name });
  }
  for (const s of W.values()) {
    if (claimed.has(s.id)) continue;
    if (mem.hidden[s.id] === s.lastActivityAt) continue;
    const p = mem.pending[s.id];
    if (p && now - p.at < PENDING_MS) continue;
    if (now - Date.parse(s.createdAt) < NEW_SESSION_GRACE_MS) continue;
    const ws = s.workspaceId ? st.workspaces.find((w) => w.id === s.workspaceId) : undefined;
    plan.createWindows.push({
      sessionId: s.id,
      name: windowName(s, st, mem.titleOverrides),
      cwd: ws?.path ?? null,
    });
  }
  for (const w of windows) {
    if (w.sessionId || !mem.added.has(w.windowId) || mem.offered.has(w.windowId)) continue;
    if (!SHELLS.includes(w.paneCommand)) continue;
    plan.offers.push({ windowId: w.windowId, paneId: w.paneId });
  }
  return plan;
}
