import type {
  AdapterInfo,
  AttentionItem,
  Automation,
  Checkout,
  Device,
  Diagnostic,
  EventData,
  EventEnvelope,
  EventType,
  Host,
  Interaction,
  Occurrence,
  Panel,
  Profile,
  Project,
  Run,
  Session,
  StreamDelta,
  SyncState,
  Task,
  TranscriptItem,
  Workspace,
} from "@switchyard/protocol";

/**
 * Pure reducers for the normalized client state. The zustand store in
 * `store.ts` wraps these; tests exercise them directly.
 */

export type ById<T> = Record<string, T>;

export interface EntityState {
  /** Last applied durable event seq (the WS cursor), null before any sync. */
  seq: number | null;
  hosts: ById<Host>;
  projects: ById<Project>;
  checkouts: ById<Checkout>;
  workspaces: ById<Workspace>;
  profiles: ById<Profile>;
  sessions: ById<Session>;
  tasks: ById<Task>;
  runs: ById<Run>;
  automations: ById<Automation>;
  /** Open (unresolved) attention items. Resolved items are dropped. */
  attention: ById<AttentionItem>;
  /** Interactions of any state, so resolution summaries stay visible inline. */
  interactions: ById<Interaction>;
  /** Keyed by `panelKey(sessionId, adapterId, slot)`. */
  panels: ById<Panel>;
  devices: ById<Device>;
  /** Adapters per host id. */
  adapters: Record<string, AdapterInfo[]>;
  /** Occurrences seen live (newest first) per automation id; history loads over REST. */
  occurrences: Record<string, Occurrence[]>;
  /** The latest diagnostics, newest last, bounded. */
  diagnostics: Diagnostic[];
  dispatchPaused: boolean;
}

export interface TranscriptState {
  /** Items sorted by `order` ascending, unique by id. */
  items: TranscriptItem[];
  /** True once the newest page has been fetched over REST. */
  loaded: boolean;
  loading: boolean;
  /** Whether older items exist before `items[0]`. */
  hasMore: boolean;
  /** Set after a snapshot resync; the next view reloads the newest page. */
  stale: boolean;
  error: string | null;
}

export interface StreamBuffer {
  sessionId: string;
  itemId: string;
  order: number | null;
  text: string;
  thinking: string;
  toolArgs: string;
  toolOutput: string;
}

export interface SyncData extends EntityState {
  transcripts: Record<string, TranscriptState>;
  /** Ephemeral stream deltas keyed by item id, appended to the durable item text. */
  streaming: Record<string, StreamBuffer>;
}

export const MAX_DIAGNOSTICS = 100;
const LIVE_RUNTIMES = new Set<string>(["starting", "running", "waiting_input"]);
export const MAX_OCCURRENCES_PER_AUTOMATION = 50;

export function panelKey(sessionId: string, adapterId: string, slot: string): string {
  return `${sessionId}:${adapterId}:${slot}`;
}

/** A panel with no node and no web renderer has been removed by its adapter. */
function keepPanel(p: Panel): boolean {
  return p.node !== null || p.webRenderer;
}

export function emptyEntities(): EntityState {
  return {
    seq: null,
    hosts: {},
    projects: {},
    checkouts: {},
    workspaces: {},
    profiles: {},
    sessions: {},
    tasks: {},
    runs: {},
    automations: {},
    attention: {},
    interactions: {},
    panels: {},
    devices: {},
    adapters: {},
    occurrences: {},
    diagnostics: [],
    dispatchPaused: false,
  };
}

export function emptySyncData(): SyncData {
  return { ...emptyEntities(), transcripts: {}, streaming: {} };
}

export function emptyTranscript(): TranscriptState {
  return { items: [], loaded: false, loading: false, hasMore: false, stale: false, error: null };
}

function byId<T extends { id: string }>(list: T[]): ById<T> {
  const out: ById<T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

function put<T>(map: ById<T>, id: string, value: T): ById<T> {
  return { ...map, [id]: value };
}

function drop<T>(map: ById<T>, id: string): ById<T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Replace every entity with a server snapshot. Loaded transcripts are kept but marked stale. */
export function applySnapshot<S extends SyncData>(state: S, seq: number, snap: SyncState): S {
  const panels: ById<Panel> = {};
  for (const p of snap.panels)
    if (keepPanel(p)) panels[panelKey(p.sessionId, p.adapterId, p.slot)] = p;
  const transcripts: Record<string, TranscriptState> = {};
  for (const [id, t] of Object.entries(state.transcripts)) transcripts[id] = { ...t, stale: true };
  return {
    ...state,
    seq,
    hosts: byId(snap.hosts),
    projects: byId(snap.projects),
    checkouts: byId(snap.checkouts),
    workspaces: byId(snap.workspaces),
    profiles: byId(snap.profiles),
    sessions: byId(snap.sessions),
    tasks: byId(snap.tasks),
    runs: byId(snap.runs),
    automations: byId(snap.automations),
    attention: byId(snap.attention.filter((a) => a.resolvedAt === null)),
    interactions: byId(snap.interactions),
    panels,
    devices: byId(snap.devices),
    adapters: { ...snap.adapters },
    dispatchPaused: snap.dispatchPaused,
    transcripts,
    streaming: {},
  };
}

/** Rebuild a SyncState from the entities (used for the offline cache). */
export function toSyncState(state: EntityState): SyncState {
  return {
    hosts: Object.values(state.hosts),
    projects: Object.values(state.projects),
    checkouts: Object.values(state.checkouts),
    workspaces: Object.values(state.workspaces),
    profiles: Object.values(state.profiles),
    sessions: Object.values(state.sessions),
    tasks: Object.values(state.tasks),
    runs: Object.values(state.runs),
    automations: Object.values(state.automations),
    attention: Object.values(state.attention),
    interactions: Object.values(state.interactions),
    panels: Object.values(state.panels),
    devices: Object.values(state.devices),
    adapters: state.adapters,
    dispatchPaused: state.dispatchPaused,
  };
}

/** Insert or replace transcript items by id, keeping `order` ascending. */
export function mergeTranscriptItems(
  existing: TranscriptItem[],
  incoming: TranscriptItem[],
): TranscriptItem[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, TranscriptItem>();
  for (const it of existing) map.set(it.id, it);
  for (const it of incoming) map.set(it.id, it);
  return [...map.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Merge a fetched page into a session transcript. `older` pages only set `hasMore`. */
export function applyTranscriptPage<S extends SyncData>(
  state: S,
  sessionId: string,
  items: TranscriptItem[],
  opts: { hasMore: boolean; older: boolean },
): S {
  const prev = state.transcripts[sessionId] ?? emptyTranscript();
  // A fresh newest page after a resync replaces items, so nothing stale lingers.
  const base = !opts.older && prev.stale ? [] : prev.items;
  const next: TranscriptState = {
    ...prev,
    items: mergeTranscriptItems(base, items),
    loaded: true,
    loading: false,
    stale: opts.older ? prev.stale : false,
    error: null,
    hasMore: opts.older || !prev.loaded || prev.stale ? opts.hasMore : prev.hasMore,
  };
  return { ...state, transcripts: { ...state.transcripts, [sessionId]: next } };
}

function upsertTranscriptItem<S extends SyncData>(state: S, item: TranscriptItem): S {
  const prev = state.transcripts[item.sessionId] ?? emptyTranscript();
  const transcripts = {
    ...state.transcripts,
    [item.sessionId]: { ...prev, items: mergeTranscriptItems(prev.items, [item]) },
  };
  // The durable item is authoritative up to now: drop any buffered deltas for it.
  const streaming = drop(state.streaming, item.id);
  return { ...state, transcripts, streaming };
}

/**
 * Apply one durable event. Events at or below the current cursor are ignored
 * (replay and live delivery may overlap).
 */
export function applyEvent<S extends SyncData>(state: S, event: EventEnvelope): S {
  if (state.seq !== null && event.seq <= state.seq) return state;
  const next = reduceEvent(state, event.type, event.data as never);
  return { ...next, seq: event.seq };
}

export function applyEvents<S extends SyncData>(state: S, events: EventEnvelope[]): S {
  let s = state;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) s = applyEvent(s, e);
  return s;
}

function reduceEvent<S extends SyncData, T extends EventType>(
  state: S,
  type: T,
  data: EventData<T>,
): S {
  switch (type) {
    case "host.updated": {
      const d = data as EventData<"host.updated">;
      return { ...state, hosts: put(state.hosts, d.id, d) };
    }
    case "project.updated": {
      const d = data as EventData<"project.updated">;
      return { ...state, projects: put(state.projects, d.id, d) };
    }
    case "project.deleted": {
      const d = data as EventData<"project.deleted">;
      return { ...state, projects: drop(state.projects, d.id) };
    }
    case "checkout.updated": {
      const d = data as EventData<"checkout.updated">;
      return { ...state, checkouts: put(state.checkouts, d.id, d) };
    }
    case "workspace.updated": {
      const d = data as EventData<"workspace.updated">;
      return {
        ...state,
        workspaces: d.archivedAt ? drop(state.workspaces, d.id) : put(state.workspaces, d.id, d),
      };
    }
    case "workspace.removed": {
      const d = data as EventData<"workspace.removed">;
      return { ...state, workspaces: drop(state.workspaces, d.id) };
    }
    case "profile.updated": {
      const d = data as EventData<"profile.updated">;
      return { ...state, profiles: put(state.profiles, d.id, d) };
    }
    case "session.updated": {
      const d = data as EventData<"session.updated">;
      const next = { ...state, sessions: put(state.sessions, d.id, d) };
      return LIVE_RUNTIMES.has(d.runtime) ? next : clearSessionStreams(next, d.id);
    }
    case "transcript.item":
      return upsertTranscriptItem(state, data as EventData<"transcript.item">);
    case "interaction.updated": {
      const d = data as EventData<"interaction.updated">;
      const prev = state.interactions[d.id];
      if (prev && prev.revision > d.revision) return state;
      return { ...state, interactions: put(state.interactions, d.id, d) };
    }
    case "panel.updated": {
      const d = data as EventData<"panel.updated">;
      const key = panelKey(d.sessionId, d.adapterId, d.slot);
      return {
        ...state,
        panels: keepPanel(d) ? put(state.panels, key, d) : drop(state.panels, key),
      };
    }
    case "adapters.updated": {
      const d = data as EventData<"adapters.updated">;
      return { ...state, adapters: { ...state.adapters, [d.hostId]: d.adapters } };
    }
    case "diagnostic": {
      const d = data as EventData<"diagnostic">;
      return { ...state, diagnostics: [...state.diagnostics, d].slice(-MAX_DIAGNOSTICS) };
    }
    case "task.updated": {
      const d = data as EventData<"task.updated">;
      return { ...state, tasks: put(state.tasks, d.id, d) };
    }
    case "task.deleted": {
      const d = data as EventData<"task.deleted">;
      return { ...state, tasks: drop(state.tasks, d.id) };
    }
    case "run.updated": {
      const d = data as EventData<"run.updated">;
      return { ...state, runs: put(state.runs, d.id, d) };
    }
    case "automation.updated": {
      const d = data as EventData<"automation.updated">;
      return { ...state, automations: put(state.automations, d.id, d) };
    }
    case "automation.deleted": {
      const d = data as EventData<"automation.deleted">;
      const occurrences = { ...state.occurrences };
      delete occurrences[d.id];
      return { ...state, automations: drop(state.automations, d.id), occurrences };
    }
    case "occurrence.created": {
      const d = data as EventData<"occurrence.created">;
      const list = (state.occurrences[d.automationId] ?? []).filter((o) => o.id !== d.id);
      return {
        ...state,
        occurrences: {
          ...state.occurrences,
          [d.automationId]: [d, ...list].slice(0, MAX_OCCURRENCES_PER_AUTOMATION),
        },
      };
    }
    case "attention.updated": {
      const d = data as EventData<"attention.updated">;
      return {
        ...state,
        attention: d.resolvedAt ? drop(state.attention, d.id) : put(state.attention, d.id, d),
      };
    }
    case "device.updated": {
      const d = data as EventData<"device.updated">;
      return {
        ...state,
        devices: d.revokedAt ? drop(state.devices, d.id) : put(state.devices, d.id, d),
      };
    }
    case "settings.updated": {
      const d = data as EventData<"settings.updated">;
      return { ...state, dispatchPaused: d.dispatchPaused };
    }
    default:
      return state;
  }
}

/** Append an ephemeral stream delta to the per-item buffer. */
export function applyStream<S extends SyncData>(state: S, delta: StreamDelta): S {
  const prev: StreamBuffer = state.streaming[delta.itemId] ?? {
    sessionId: delta.sessionId,
    itemId: delta.itemId,
    order: delta.order ?? null,
    text: "",
    thinking: "",
    toolArgs: "",
    toolOutput: "",
  };
  const field =
    delta.kind === "text"
      ? "text"
      : delta.kind === "thinking"
        ? "thinking"
        : delta.kind === "tool_args"
          ? "toolArgs"
          : "toolOutput";
  const next: StreamBuffer = {
    ...prev,
    order: prev.order ?? delta.order ?? null,
    [field]: prev[field] + delta.delta,
  };
  return { ...state, streaming: { ...state.streaming, [delta.itemId]: next } };
}

/** Drop all stream buffers of a session (for example when it settles). */
export function clearSessionStreams<S extends SyncData>(state: S, sessionId: string): S {
  const streaming: Record<string, StreamBuffer> = {};
  let changed = false;
  for (const [id, b] of Object.entries(state.streaming)) {
    if (b.sessionId === sessionId) changed = true;
    else streaming[id] = b;
  }
  return changed ? { ...state, streaming } : state;
}
