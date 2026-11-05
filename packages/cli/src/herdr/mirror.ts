import { basename } from "node:path";
import type { Session, View } from "@switchyard/protocol";

import {
  type AgentState,
  agentState,
  LIVE_RUNTIMES,
  type MirrorState,
  mirroredSessions,
  NEW_SESSION_GRACE_MS,
  PENDING_MS,
  viewedSessions,
} from "../mirror/state.js";

export type { AgentState, MirrorState };
export { agentState, LIVE_RUNTIMES, mirroredSessions, NEW_SESSION_GRACE_MS, PENDING_MS };

/** The herdr source (and agent name) this integration reports as. */
export const SOURCE = "switchyard";
/** The pane token naming the session a pane shows (herdr keeps session refs only for its own integrations). */
export const SESSION_TOKEN = "switchyard_session";
const LABEL_MAX = 40;

export interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string | null;
  agent_session?: { source: string; agent: string; kind: string; value: string } | null;
  tokens?: Record<string, string> | null;
  /** The agent herdr shows in the pane; cleared once the pane is back at its shell. */
  agent?: string | null;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  number: number;
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
}

export interface SpaceRecord {
  key: string;
  label: string;
}

export interface MirrorMemory {
  /** herdr workspace id -> the Switchyard space it mirrors (persisted). */
  spaces: Record<string, SpaceRecord>;
  /** herdr tab id -> session id, for tabs the mirror created (persisted). */
  ownTabs: Record<string, string>;
  /** session id -> a pane command typed but not yet claimed. */
  pending: Record<string, { tabId: string; at: number }>;
  /** Tabs where the new-session picker was typed, or that must never get it. */
  offered: Set<string>;
  /** session id -> title just requested from a tab rename. */
  titleOverrides: Record<string, string>;
}

export interface MirrorPlan {
  closeTabs: { tabId: string; sessionId: string }[];
  moves: { paneId: string; sessionId: string; toWorkspaceId: string | null; label: string }[];
  createSpaces: {
    key: string;
    label: string;
    cwd: string | null;
    firstSessionId: string;
    firstTabLabel: string;
    insertIndex: number | null;
  }[];
  createTabs: { workspaceId: string; sessionId: string; label: string; cwd: string | null }[];
  restarts: { paneId: string; sessionId: string }[];
  renameTabs: { tabId: string; label: string }[];
  renameSpaces: { workspaceId: string; label: string }[];
  closeSpaces: string[];
  reports: {
    paneId: string;
    sessionId: string;
    state: AgentState;
    message: string;
    displayAgent: string;
  }[];
  offers: { tabId: string; paneId: string; workspaceKey: string | null }[];
  spaces: Record<string, SpaceRecord>;
}

export function emptyMemory(): MirrorMemory {
  return { spaces: {}, ownTabs: {}, pending: {}, offered: new Set(), titleOverrides: {} };
}

function cap(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** The Switchyard space a session belongs to: its workspace, else its host and cwd. */
export function spaceKey(s: Session): string {
  return s.workspaceId ?? `cwd:${s.hostId}:${s.cwd}`;
}

function hostName(st: MirrorState, hostId: string): string {
  return st.hosts.find((h) => h.id === hostId)?.name ?? hostId;
}

/** The project a space key belongs to, if any. */
export function projectOfKey(key: string, st: MirrorState): string | null {
  const w = st.workspaces.find((x) => x.id === key);
  if (w) return w.projectId;
  return st.sessions.find((s) => spaceKey(s) === key)?.projectId ?? null;
}

/** `<project>[ · <branch>][ · <host>]`, at most 40 characters. */
export function spaceLabel(key: string, st: MirrorState): string {
  const w = st.workspaces.find((x) => x.id === key);
  if (w) {
    const project = st.projects.find((p) => p.id === w.projectId)?.name ?? basename(w.path);
    let label = project;
    if (w.provenance !== "main") label += ` · ${w.branch ?? basename(w.path)}`;
    const hosts = new Set(
      st.checkouts.filter((c) => c.projectId === w.projectId).map((c) => c.hostId),
    );
    if (hosts.size >= 2) label += ` · ${hostName(st, w.hostId)}`;
    return cap(label);
  }
  const cwd = key.split(":").slice(2).join(":");
  const s = st.sessions.find((x) => spaceKey(x) === key);
  const project = (s?.projectId && st.projects.find((p) => p.id === s.projectId)?.name) || null;
  return cap(`${project ?? basename(cwd)} · ${basename(cwd)}`);
}

export function tabLabel(s: Session, overrides: Record<string, string> = {}): string {
  return cap(overrides[s.id] ?? s.title);
}

export function claimedSession(p: HerdrPane): string | null {
  const token = p.tokens?.[SESSION_TOKEN];
  if (token) return token;
  return p.agent_session?.source === SOURCE ? p.agent_session.value : null;
}

/** Compare Switchyard with the paired herdr session and say what to change. Pure. */
export function planMirror(
  st: MirrorState,
  h: HerdrSnapshot,
  mem: MirrorMemory,
  now: number,
  view: View | null = null,
): MirrorPlan {
  const plan: MirrorPlan = {
    closeTabs: [],
    moves: [],
    createSpaces: [],
    createTabs: [],
    restarts: [],
    renameTabs: [],
    renameSpaces: [],
    closeSpaces: [],
    reports: [],
    offers: [],
    spaces: {},
  };
  const M = new Map(viewedSessions(st, view).map((s) => [s.id, s]));
  const workspaces = [...h.workspaces].sort((a, b) => a.number - b.number);
  const present = new Set(workspaces.map((w) => w.workspace_id));
  const tabsPresent = new Set(h.tabs.map((t) => t.tab_id));
  const panesOfTab = new Map<string, HerdrPane[]>();
  for (const p of h.panes) panesOfTab.set(p.tab_id, [...(panesOfTab.get(p.tab_id) ?? []), p]);

  // 1-2. Claims and space keys.
  const claimedPanes = new Map<string, HerdrPane[]>(); // session id -> panes
  const keyVotes = new Map<string, Map<string, number>>(); // workspace -> key -> votes
  const firstKey = new Map<string, string>();
  for (const p of h.panes) {
    const sid = claimedSession(p);
    if (!sid) continue;
    claimedPanes.set(sid, [...(claimedPanes.get(sid) ?? []), p]);
    const s = M.get(sid);
    if (!s) continue;
    const key = spaceKey(s);
    const votes = keyVotes.get(p.workspace_id) ?? new Map<string, number>();
    votes.set(key, (votes.get(key) ?? 0) + 1);
    keyVotes.set(p.workspace_id, votes);
    if (!firstKey.has(p.workspace_id)) firstKey.set(p.workspace_id, key);
  }
  const keyOfSpace = new Map<string, string>();
  for (const w of workspaces) {
    const votes = keyVotes.get(w.workspace_id);
    if (votes && votes.size > 0) {
      let best = firstKey.get(w.workspace_id)!;
      for (const [k, n] of votes) if (n > (votes.get(best) ?? 0)) best = k;
      keyOfSpace.set(w.workspace_id, best);
    } else if (mem.spaces[w.workspace_id]) {
      keyOfSpace.set(w.workspace_id, mem.spaces[w.workspace_id]!.key);
    }
  }
  const spaceOfKey = new Map<string, string>();
  for (const w of workspaces) {
    const k = keyOfSpace.get(w.workspace_id);
    if (k && !spaceOfKey.has(k)) spaceOfKey.set(k, w.workspace_id);
  }

  // 3. Tabs of sessions that are gone.
  for (const t of h.tabs) {
    const panes = panesOfTab.get(t.tab_id) ?? [];
    if (panes.length === 0) continue;
    const owners = new Set(panes.map(claimedSession));
    if (owners.size !== 1) continue;
    const sid = [...owners][0];
    if (sid && !M.has(sid)) plan.closeTabs.push({ tabId: t.tab_id, sessionId: sid });
  }

  // 4. Panes in the wrong space.
  const movingTo = new Set<string>();
  for (const [sid, panes] of claimedPanes) {
    const s = M.get(sid);
    if (!s) continue;
    const key = spaceKey(s);
    for (const p of panes) {
      // Only the first space with a key is that key's space; duplicates merge into it.
      const target = spaceOfKey.get(key) ?? null;
      if (target === p.workspace_id) continue;
      if (target === null) {
        if (movingTo.has(key)) continue; // one new space per key; the rest follow next time
        movingTo.add(key);
      }
      plan.moves.push({
        paneId: p.pane_id,
        sessionId: sid,
        toWorkspaceId: target,
        label: target === null ? spaceLabel(key, st) : tabLabel(s, mem.titleOverrides),
      });
    }
  }

  // 5-7. Spaces and tabs for sessions without a pane.
  const fresh = (sid: string) => {
    const p = mem.pending[sid];
    return p !== undefined && now - p.at < PENDING_MS;
  };
  const createdKeys = new Set<string>();
  for (const s of M.values()) {
    if (claimedPanes.has(s.id) || fresh(s.id)) continue;
    if (now - Date.parse(s.createdAt) < NEW_SESSION_GRACE_MS) continue;
    const key = spaceKey(s);
    const space = spaceOfKey.get(key);
    if (!space) {
      if (movingTo.has(key) || createdKeys.has(key)) continue;
      createdKeys.add(key);
      const w = st.workspaces.find((x) => x.id === key);
      const cwd = w ? w.path : key.startsWith("cwd:") ? key.split(":").slice(2).join(":") : null;
      const project = projectOfKey(key, st);
      let insertIndex: number | null = null;
      if (project) {
        workspaces.forEach((ws, i) => {
          const k = keyOfSpace.get(ws.workspace_id);
          if (k && projectOfKey(k, st) === project) insertIndex = i + 1;
        });
      }
      plan.createSpaces.push({
        key,
        label: spaceLabel(key, st),
        cwd,
        firstSessionId: s.id,
        firstTabLabel: tabLabel(s, mem.titleOverrides),
        insertIndex,
      });
      continue;
    }
    const ownTab = Object.entries(mem.ownTabs).find(
      ([tabId, sid]) => sid === s.id && tabsPresent.has(tabId),
    );
    if (ownTab) {
      const pane = panesOfTab.get(ownTab[0])?.[0];
      if (pane) plan.restarts.push({ paneId: pane.pane_id, sessionId: s.id });
      continue;
    }
    const w = st.workspaces.find((x) => x.id === key);
    plan.createTabs.push({
      workspaceId: space,
      sessionId: s.id,
      label: tabLabel(s, mem.titleOverrides),
      cwd: w ? w.path : null,
    });
  }

  // A pane whose session token outlived its pane process (killed, crashed): run it again.
  for (const [sid, panes] of claimedPanes) {
    if (!M.has(sid) || fresh(sid)) continue;
    for (const p of panes) {
      if (p.tokens?.[SESSION_TOKEN] && p.agent !== SOURCE) {
        plan.restarts.push({ paneId: p.pane_id, sessionId: sid });
      }
    }
  }

  // 8. Tab labels follow session titles.
  for (const t of h.tabs) {
    const owners = new Set((panesOfTab.get(t.tab_id) ?? []).map(claimedSession).filter(Boolean));
    if (owners.size !== 1) continue;
    const s = M.get([...owners][0] as string);
    if (!s) continue;
    const label = tabLabel(s, mem.titleOverrides);
    if (t.label !== label) plan.renameTabs.push({ tabId: t.tab_id, label });
  }

  // 9. Space labels change only when Switchyard's label changes.
  for (const w of workspaces) {
    const key = keyOfSpace.get(w.workspace_id);
    if (!key) continue;
    const computed = spaceLabel(key, st);
    const last = mem.spaces[w.workspace_id]?.label;
    if (last !== computed && w.label !== computed) {
      plan.renameSpaces.push({ workspaceId: w.workspace_id, label: computed });
    }
    plan.spaces[w.workspace_id] = { key, label: computed };
  }

  // 10. Own spaces with nothing left to show.
  const liveKeys = new Set([...M.values()].map(spaceKey));
  const claimedSpaces = new Set(
    h.panes.filter((p) => claimedSession(p) !== null).map((p) => p.workspace_id),
  );
  for (const [id, rec] of Object.entries(mem.spaces)) {
    if (!present.has(id)) continue;
    if (claimedSpaces.has(id) || liveKeys.has(rec.key)) {
      plan.spaces[id] ??= rec;
      continue;
    }
    plan.closeSpaces.push(id);
    delete plan.spaces[id];
  }

  // 11. State for each claimed pane.
  for (const [sid, panes] of claimedPanes) {
    const s = M.get(sid);
    if (!s) continue;
    const message =
      (s.runtime === "failed" || s.runtime === "interrupted") && s.runtimeDetail
        ? s.runtimeDetail
        : s.runtime;
    for (const p of panes) {
      plan.reports.push({
        paneId: p.pane_id,
        sessionId: sid,
        state: agentState(s.runtime),
        message,
        displayAgent: `pi · ${hostName(st, s.hostId)}`,
      });
    }
  }

  // 12. New tabs someone opened: offer the new-session picker.
  for (const t of h.tabs) {
    const panes = panesOfTab.get(t.tab_id) ?? [];
    if (panes.length !== 1) continue;
    if (claimedSession(panes[0]!) !== null) continue;
    if (mem.ownTabs[t.tab_id] !== undefined || mem.offered.has(t.tab_id)) continue;
    const key = keyOfSpace.get(t.workspace_id);
    // Only spaces the mirror owns: in a mixed session, your own spaces stay plain shells.
    if (key === undefined) continue;
    plan.offers.push({
      tabId: t.tab_id,
      paneId: panes[0]!.pane_id,
      workspaceKey: key && !key.startsWith("cwd:") ? key : null,
    });
  }
  return plan;
}
