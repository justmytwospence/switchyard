import { basename } from "node:path";
import type { Session, View } from "@switchyard/protocol";
import {
  type MirrorState,
  NEW_SESSION_GRACE_MS,
  PENDING_MS,
  viewedSessions,
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
}

export interface TmuxMemory {
  /** window id -> session id, for windows the mirror created (persisted). */
  ownWindows: Record<string, string>;
  pending: Record<string, { windowId: string; at: number }>;
  offered: Set<string>;
  /** Windows that appeared (`%window-add`) after the daemon started. */
  added: Set<string>;
  titleOverrides: Record<string, string>;
}

export interface TmuxPlan {
  closeWindows: { windowId: string; sessionId: string }[];
  createWindows: { sessionId: string; name: string; cwd: string | null }[];
  respawns: { paneId: string; sessionId: string }[];
  renames: { windowId: string; name: string }[];
  offers: { windowId: string; paneId: string }[];
}

export function emptyTmuxMemory(): TmuxMemory {
  return { ownWindows: {}, pending: {}, offered: new Set(), added: new Set(), titleOverrides: {} };
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

/** Compare Switchyard with the paired tmux session and say what to change. Pure. */
export function planTmux(
  st: MirrorState,
  view: View | null,
  windows: TmuxWindow[],
  mem: TmuxMemory,
  now: number,
): TmuxPlan {
  const plan: TmuxPlan = {
    closeWindows: [],
    createWindows: [],
    respawns: [],
    renames: [],
    offers: [],
  };
  const M = new Map(viewedSessions(st, view).map((s) => [s.id, s]));
  const claimed = new Set<string>();
  for (const w of windows) {
    if (!w.sessionId) continue;
    claimed.add(w.sessionId);
    const s = M.get(w.sessionId);
    if (!s) {
      plan.closeWindows.push({ windowId: w.windowId, sessionId: w.sessionId });
      continue;
    }
    if (w.paneDead) plan.respawns.push({ paneId: w.paneId, sessionId: s.id });
    const name = windowName(s, st, mem.titleOverrides);
    if (w.name !== name) plan.renames.push({ windowId: w.windowId, name });
  }
  for (const s of M.values()) {
    if (claimed.has(s.id)) continue;
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
