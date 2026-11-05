import type {
  AttentionItem,
  EventEnvelope,
  Interaction,
  Panel,
  Run,
  Session,
  StreamDelta,
  SyncState,
  Task,
  TaskState,
  TranscriptItem,
} from "@switchyard/protocol";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { apiGet, errorMessage } from "./api";
import {
  applyEvent,
  applyEvents,
  applySnapshot,
  applyStream,
  applyTranscriptPage,
  emptySyncData,
  emptyTranscript,
  type StreamBuffer,
  type SyncData,
  type TranscriptState,
} from "./reduce";
import { isOpenAttention, isUnacknowledgedAttention, pendingInteractionsFor } from "./selectors";

export type { StreamBuffer, SyncData, TranscriptState } from "./reduce";
export { panelKey } from "./reduce";
export { pendingInteractionsFor } from "./selectors";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface ConnectionInfo {
  state: ConnectionState;
  /** Consecutive failed connection attempts. */
  attempts: number;
}

export interface SyncStore extends SyncData {
  /** Some data is present (from the offline cache or the server). */
  hydrated: boolean;
  /** Server data was received during this page load. */
  synced: boolean;
  connection: ConnectionInfo;
  /**
   * When the client last received data from the coordinator (ISO). Top-level so live events
   * do not change `connection`.
   */
  lastSyncedAt: string | null;

  hydrateFromCache(seq: number, state: SyncState, savedAt: string): void;
  applySnapshot(seq: number, state: SyncState): void;
  applyReplay(seq: number, events: EventEnvelope[]): void;
  applyEvent(event: EventEnvelope): void;
  applyStream(delta: StreamDelta): void;
  setConnection(patch: Partial<ConnectionInfo>): void;
  /** Record that data just arrived from the coordinator. */
  markSynced(): void;
  /** Store an interaction returned by a REST acknowledgement (answer, 409 already_answered). */
  upsertInteraction(interaction: Interaction): void;
  /** Insert a session from an HTTP response; never replaces one sync already delivered. */
  upsertSessionIfMissing(session: Session): void;
  /** Fetch the newest transcript page (or reload it after a resync). */
  loadTranscript(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  /** Fetch the page before the oldest loaded item. */
  loadOlderTranscript(sessionId: string): Promise<void>;
  /** Clear all data (logout). */
  reset(): void;
}

export const TRANSCRIPT_PAGE = 200;

interface TranscriptPage {
  items: TranscriptItem[];
  hasMore?: boolean;
}

function normalizePage(res: TranscriptPage | TranscriptItem[], limit: number): TranscriptPage {
  const items = Array.isArray(res) ? res : (res.items ?? []);
  const hasMore = Array.isArray(res) ? undefined : res.hasMore;
  return { items, hasMore: hasMore ?? items.length >= limit };
}

const inflight = new Map<string, Promise<void>>();

export const useSyncStore = create<SyncStore>()((set, get) => ({
  ...emptySyncData(),
  hydrated: false,
  synced: false,
  connection: { state: "connecting", attempts: 0 },
  lastSyncedAt: null,

  hydrateFromCache(seq, state, savedAt) {
    if (get().synced) return;
    set((s) => ({
      ...applySnapshot(s, seq, state),
      hydrated: true,
      lastSyncedAt: s.lastSyncedAt ?? savedAt,
    }));
  },
  applySnapshot(seq, state) {
    set((s) => ({
      ...applySnapshot(s, seq, state),
      hydrated: true,
      synced: true,
      lastSyncedAt: new Date().toISOString(),
    }));
  },
  applyReplay(seq, events) {
    set((s) => {
      const next = applyEvents(s, events);
      return {
        ...next,
        seq: Math.max(next.seq ?? 0, seq),
        hydrated: true,
        synced: true,
        lastSyncedAt: new Date().toISOString(),
      };
    });
  },
  applyEvent(event) {
    set((s) => ({ ...applyEvent(s, event), lastSyncedAt: new Date().toISOString() }));
  },
  applyStream(delta) {
    set((s) => applyStream(s, delta));
  },
  setConnection(patch) {
    set((s) => ({ connection: { ...s.connection, ...patch } }));
  },
  markSynced() {
    set({ lastSyncedAt: new Date().toISOString() });
  },
  upsertInteraction(interaction) {
    set((s) => {
      const prev = s.interactions[interaction.id];
      if (prev && prev.revision > interaction.revision) return {};
      return { interactions: { ...s.interactions, [interaction.id]: interaction } };
    });
  },
  upsertSessionIfMissing(session) {
    set((s) =>
      s.sessions[session.id] ? {} : { sessions: { ...s.sessions, [session.id]: session } },
    );
  },
  loadTranscript(sessionId, opts) {
    const t = get().transcripts[sessionId];
    if (t?.loaded && !t.stale && !opts?.force) return Promise.resolve();
    const key = `${sessionId}:newest`;
    const existing = inflight.get(key);
    if (existing) return existing;
    setTranscript(set, sessionId, { loading: true, error: null });
    const p = apiGet<TranscriptPage | TranscriptItem[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { limit: TRANSCRIPT_PAGE },
    )
      .then((res) => {
        const page = normalizePage(res, TRANSCRIPT_PAGE);
        set((s) =>
          applyTranscriptPage(s, sessionId, page.items, {
            hasMore: page.hasMore ?? false,
            older: false,
          }),
        );
      })
      .catch((e) => setTranscript(set, sessionId, { loading: false, error: errorMessage(e) }))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },
  loadOlderTranscript(sessionId) {
    const t = get().transcripts[sessionId];
    if (!t?.loaded || !t.hasMore || t.items.length === 0) return Promise.resolve();
    const before = t.items[0]!.order;
    const key = `${sessionId}:before:${before}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    setTranscript(set, sessionId, { loading: true, error: null });
    const p = apiGet<TranscriptPage | TranscriptItem[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { before, limit: TRANSCRIPT_PAGE },
    )
      .then((res) => {
        const page = normalizePage(res, TRANSCRIPT_PAGE);
        set((s) =>
          applyTranscriptPage(s, sessionId, page.items, {
            hasMore: page.hasMore ?? false,
            older: true,
          }),
        );
      })
      .catch((e) => setTranscript(set, sessionId, { loading: false, error: errorMessage(e) }))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },
  reset() {
    set({
      ...emptySyncData(),
      hydrated: false,
      synced: false,
      connection: { state: "connecting", attempts: 0 },
      lastSyncedAt: null,
    });
  },
}));

function setTranscript(
  set: (fn: (s: SyncStore) => Partial<SyncStore>) => void,
  sessionId: string,
  patch: Partial<TranscriptState>,
) {
  set((s) => ({
    transcripts: {
      ...s.transcripts,
      [sessionId]: { ...(s.transcripts[sessionId] ?? emptyTranscript()), ...patch },
    },
  }));
}

export const syncStore = useSyncStore;

/* ------------------------------------------------------------------ */
/* Pure selectors (take entity maps; safe to use in useMemo or tests). */
/* ------------------------------------------------------------------ */

export const TASK_COLUMNS: TaskState[] = ["backlog", "ready", "in_progress", "review", "done"];

export function compareTasks(a: Task, b: Task): number {
  return (
    a.priority - b.priority || a.position - b.position || a.createdAt.localeCompare(b.createdAt)
  );
}

/** Tasks grouped by state, sorted by (priority, position, createdAt). Hidden routine tasks are omitted. */
export function groupTasksByState(
  tasks: Record<string, Task>,
  opts: { projectId?: string | null; includeHidden?: boolean } = {},
): Record<TaskState, Task[]> {
  const out: Record<TaskState, Task[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
    canceled: [],
  };
  for (const t of Object.values(tasks)) {
    if (opts.projectId && t.projectId !== opts.projectId) continue;
    if (t.hiddenFromBoard && !opts.includeHidden) continue;
    out[t.state].push(t);
  }
  for (const k of Object.keys(out) as TaskState[]) out[k].sort(compareTasks);
  return out;
}

/** Non-archived sessions, most recent activity first. */
export function sortSessions(sessions: Record<string, Session>): Session[] {
  return Object.values(sessions)
    .filter((s) => s.archivedAt === null)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** Open attention, newest first. */
export function sortAttention(attention: Record<string, AttentionItem>): AttentionItem[] {
  return Object.values(attention)
    .filter(isOpenAttention)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Count shown on the Attention badge: open and not yet acknowledged. */
export function countAttention(attention: Record<string, AttentionItem>): number {
  let n = 0;
  for (const a of Object.values(attention)) if (isUnacknowledgedAttention(a)) n++;
  return n;
}

export function runsForTask(runs: Record<string, Run>, taskId: string): Run[] {
  return Object.values(runs)
    .filter((r) => r.taskId === taskId)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt));
}

export function panelsForSession(panels: Record<string, Panel>, sessionId: string): Panel[] {
  return Object.values(panels)
    .filter((p) => p.sessionId === sessionId)
    .sort((a, b) => a.adapterId.localeCompare(b.adapterId) || a.slot.localeCompare(b.slot));
}

export function streamsForSession(
  streaming: Record<string, StreamBuffer>,
  sessionId: string,
): StreamBuffer[] {
  return Object.values(streaming).filter((b) => b.sessionId === sessionId);
}

/* ------------------------------------------------------------------ */
/* Hooks. Each selects stable maps and derives with useMemo.          */
/* ------------------------------------------------------------------ */

export const useConnection = () => useSyncStore((s) => s.connection);
export const useConnectionState = () => useSyncStore((s) => s.connection.state);
/** Last sync time while the link is down; null while live so live events never re-render. */
export const useStaleSince = () =>
  useSyncStore((s) => (s.connection.state === "live" ? null : s.lastSyncedAt));
export const useHost = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.hosts[id] : undefined));
export const useProject = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.projects[id] : undefined));
export const useWorkspace = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.workspaces[id] : undefined));
export const useSession = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.sessions[id] : undefined));
export const useTask = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.tasks[id] : undefined));
export const useRun = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.runs[id] : undefined));
export const useAutomation = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.automations[id] : undefined));
export const useInteraction = (id: string | null | undefined) =>
  useSyncStore((s) => (id ? s.interactions[id] : undefined));

export function useProjects() {
  const projects = useSyncStore((s) => s.projects);
  return useMemo(
    () => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );
}

export function useHosts() {
  const hosts = useSyncStore((s) => s.hosts);
  return useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.revokedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  );
}

export function useSessions() {
  const sessions = useSyncStore((s) => s.sessions);
  return useMemo(() => sortSessions(sessions), [sessions]);
}

export function useTasksByState(opts: { projectId?: string | null; includeHidden?: boolean } = {}) {
  const tasks = useSyncStore((s) => s.tasks);
  const { projectId, includeHidden } = opts;
  return useMemo(
    () => groupTasksByState(tasks, { projectId, includeHidden }),
    [tasks, projectId, includeHidden],
  );
}

export function useOpenAttention() {
  const attention = useSyncStore((s) => s.attention);
  return useMemo(() => sortAttention(attention), [attention]);
}

export function useAttentionCount() {
  return useSyncStore((s) => countAttention(s.attention));
}

export function usePendingInteractions(sessionId: string | null | undefined) {
  const interactions = useSyncStore((s) => s.interactions);
  return useMemo(
    () => (sessionId ? pendingInteractionsFor(interactions, sessionId) : []),
    [interactions, sessionId],
  );
}

export function useRunsForTask(taskId: string | null | undefined) {
  const runs = useSyncStore((s) => s.runs);
  return useMemo(() => (taskId ? runsForTask(runs, taskId) : []), [runs, taskId]);
}

export function usePanels(sessionId: string | null | undefined) {
  const panels = useSyncStore((s) => s.panels);
  return useMemo(() => (sessionId ? panelsForSession(panels, sessionId) : []), [panels, sessionId]);
}

export function useStreams(sessionId: string | null | undefined) {
  const streaming = useSyncStore((s) => s.streaming);
  return useMemo(
    () => (sessionId ? streamsForSession(streaming, sessionId) : []),
    [streaming, sessionId],
  );
}

const EMPTY_TRANSCRIPT = emptyTranscript();

/** Transcript for a session; loads the newest page on mount (and after a resync). */
export function useTranscript(sessionId: string | null | undefined): TranscriptState {
  const t = useSyncStore((s) => (sessionId ? s.transcripts[sessionId] : undefined));
  const load = useSyncStore((s) => s.loadTranscript);
  const needsLoad = !!sessionId && (!t || ((!t.loaded || t.stale) && !t.loading && !t.error));
  useEffect(() => {
    if (needsLoad && sessionId) void load(sessionId);
  }, [needsLoad, sessionId, load]);
  return t ?? EMPTY_TRANSCRIPT;
}
