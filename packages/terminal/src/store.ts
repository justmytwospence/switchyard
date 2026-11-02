import type {
  AttentionItem,
  Automation,
  Checkout,
  Device,
  EventData,
  EventEnvelope,
  EventType,
  Host,
  Interaction,
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
 * Normalized client state and its pure reducers. Same semantics as the web store
 * (`packages/web/src/sync/reduce.ts`): durable events apply once in `seq` order, a snapshot
 * replaces every entity and marks loaded transcripts stale, stream deltas are buffered per item
 * and dropped when the durable item arrives or the session leaves a live runtime.
 */

export type ById<T> = Record<string, T>;

export type ConnectionState = "connecting" | "live" | "reconnecting" | "logged_out";

export interface TranscriptState {
  /** Items sorted by `order` ascending, unique by id. */
  items: TranscriptItem[];
  loaded: boolean;
  hasMore: boolean;
  /** Set after a snapshot resync; the next view reloads the newest page. */
  stale: boolean;
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

export interface ClientState {
  /** Last applied durable event seq (the WS cursor), null before any sync. */
  seq: number | null;
  synced: boolean;
  connection: { state: ConnectionState; attempts: number; reason: string | null };
  hosts: ById<Host>;
  projects: ById<Project>;
  checkouts: ById<Checkout>;
  workspaces: ById<Workspace>;
  profiles: ById<Profile>;
  sessions: ById<Session>;
  tasks: ById<Task>;
  runs: ById<Run>;
  automations: ById<Automation>;
  /** Open (unresolved) attention items. */
  attention: ById<AttentionItem>;
  /** Interactions of any state, so resolution summaries stay visible. */
  interactions: ById<Interaction>;
  panels: ById<Panel>;
  devices: ById<Device>;
  dispatchPaused: boolean;
  transcripts: Record<string, TranscriptState>;
  streaming: Record<string, StreamBuffer>;
}

const LIVE_RUNTIMES = new Set<string>(["starting", "running", "waiting_input"]);

export function emptyState(): ClientState {
  return {
    seq: null,
    synced: false,
    connection: { state: "connecting", attempts: 0, reason: null },
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
    dispatchPaused: false,
    transcripts: {},
    streaming: {},
  };
}

export function emptyTranscript(): TranscriptState {
  return { items: [], loaded: false, hasMore: false, stale: false };
}

export function panelKey(sessionId: string, adapterId: string, slot: string): string {
  return `${sessionId}:${adapterId}:${slot}`;
}

function keepPanel(p: Panel): boolean {
  return p.node !== null || p.webRenderer;
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
export function applySnapshot(state: ClientState, seq: number, snap: SyncState): ClientState {
  const panels: ById<Panel> = {};
  for (const p of snap.panels) {
    if (keepPanel(p)) panels[panelKey(p.sessionId, p.adapterId, p.slot)] = p;
  }
  const transcripts: Record<string, TranscriptState> = {};
  for (const [id, t] of Object.entries(state.transcripts)) transcripts[id] = { ...t, stale: true };
  return {
    ...state,
    seq,
    synced: true,
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
    dispatchPaused: snap.dispatchPaused,
    transcripts,
    streaming: {},
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

/** Merge the newest page fetched over REST. A stale transcript is replaced, not merged. */
export function applyTranscriptPage(
  state: ClientState,
  sessionId: string,
  items: TranscriptItem[],
  hasMore: boolean,
): ClientState {
  const prev = state.transcripts[sessionId] ?? emptyTranscript();
  const base = prev.stale ? [] : prev.items;
  const next: TranscriptState = {
    items: mergeTranscriptItems(base, items),
    loaded: true,
    stale: false,
    hasMore,
  };
  return { ...state, transcripts: { ...state.transcripts, [sessionId]: next } };
}

function upsertTranscriptItem(state: ClientState, item: TranscriptItem): ClientState {
  const prev = state.transcripts[item.sessionId] ?? emptyTranscript();
  const transcripts = {
    ...state.transcripts,
    [item.sessionId]: { ...prev, items: mergeTranscriptItems(prev.items, [item]) },
  };
  return { ...state, transcripts, streaming: drop(state.streaming, item.id) };
}

/** Insert or replace an interaction unless a newer revision is already known. */
export function upsertInteraction(state: ClientState, i: Interaction): ClientState {
  const prev = state.interactions[i.id];
  if (prev && prev.revision > i.revision) return state;
  return { ...state, interactions: put(state.interactions, i.id, i) };
}

/**
 * Apply a host session snapshot (`GET /api/sessions/:id/snapshot`): the current partial items
 * become transcript items (later replaced by their durable versions) and pending interactions
 * are upserted.
 */
export function applySessionSnapshot(
  state: ClientState,
  sessionId: string,
  snap: { partial: TranscriptItem[]; pendingInteractions: Interaction[] },
): ClientState {
  let s = state;
  const prev = s.transcripts[sessionId] ?? emptyTranscript();
  const partial = snap.partial.filter((p) => !prev.items.some((x) => x.id === p.id));
  if (partial.length > 0) {
    s = {
      ...s,
      transcripts: {
        ...s.transcripts,
        [sessionId]: { ...prev, items: mergeTranscriptItems(prev.items, partial) },
      },
    };
  }
  for (const i of snap.pendingInteractions) s = upsertInteraction(s, i);
  return s;
}

/** Apply one durable event; events at or below the cursor are ignored. */
export function applyEvent(state: ClientState, event: EventEnvelope): ClientState {
  if (state.seq !== null && event.seq <= state.seq) return state;
  const next = reduceEvent(state, event.type, event.data as never);
  return { ...next, seq: event.seq };
}

/** Apply a replay batch in `seq` order and record the server's current seq. */
export function applyReplay(state: ClientState, seq: number, events: EventEnvelope[]): ClientState {
  let s = state;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) s = applyEvent(s, e);
  return { ...s, seq: Math.max(s.seq ?? 0, seq), synced: true };
}

function reduceEvent<T extends EventType>(
  state: ClientState,
  type: T,
  data: EventData<T>,
): ClientState {
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
    case "profile.deleted": {
      const d = data as EventData<"profile.deleted">;
      return { ...state, profiles: drop(state.profiles, d.id) };
    }
    case "session.updated": {
      const d = data as EventData<"session.updated">;
      const next = { ...state, sessions: put(state.sessions, d.id, d) };
      return LIVE_RUNTIMES.has(d.runtime) ? next : clearSessionStreams(next, d.id);
    }
    case "transcript.item":
      return upsertTranscriptItem(state, data as EventData<"transcript.item">);
    case "interaction.updated":
      return upsertInteraction(state, data as EventData<"interaction.updated">);
    case "panel.updated": {
      const d = data as EventData<"panel.updated">;
      const key = panelKey(d.sessionId, d.adapterId, d.slot);
      return {
        ...state,
        panels: keepPanel(d) ? put(state.panels, key, d) : drop(state.panels, key),
      };
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
      return { ...state, automations: drop(state.automations, d.id) };
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

/** Append an ephemeral stream delta to its per-item buffer. */
export function applyStream(state: ClientState, delta: StreamDelta): ClientState {
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
export function clearSessionStreams(state: ClientState, sessionId: string): ClientState {
  const streaming: Record<string, StreamBuffer> = {};
  let changed = false;
  for (const [id, b] of Object.entries(state.streaming)) {
    if (b.sessionId === sessionId) changed = true;
    else streaming[id] = b;
  }
  return changed ? { ...state, streaming } : state;
}

export function setConnection(
  state: ClientState,
  connection: Partial<ClientState["connection"]>,
): ClientState {
  return { ...state, connection: { ...state.connection, ...connection } };
}

type Listener = () => void;

/** A tiny observable holder for `ClientState` (usable with `useSyncExternalStore`). */
export class Store {
  private state: ClientState = emptyState();
  private listeners = new Set<Listener>();

  getState = (): ClientState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  update(fn: (s: ClientState) => ClientState): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}
