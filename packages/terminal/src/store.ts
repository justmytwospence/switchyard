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
  SyncState,
  Task,
  View,
  Workspace,
} from "@switchyard/protocol";
import { canonicalEventType } from "@switchyard/protocol";

/**
 * Normalized client state of coordinator entities and its pure reducers: durable events apply
 * once in `seq` order, a snapshot replaces every entity. Transcripts and stream deltas are not kept.
 */

export type ById<T> = Record<string, T>;

export type ConnectionState = "connecting" | "live" | "reconnecting" | "logged_out";

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
  views: ById<View>;
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
}

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
    views: {},
    sessions: {},
    tasks: {},
    runs: {},
    automations: {},
    attention: {},
    interactions: {},
    panels: {},
    devices: {},
    dispatchPaused: false,
  };
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

/** Replace every entity with a server snapshot. */
export function applySnapshot(state: ClientState, seq: number, snap: SyncState): ClientState {
  const panels: ById<Panel> = {};
  for (const p of snap.panels) {
    if (keepPanel(p)) panels[panelKey(p.sessionId, p.adapterId, p.slot)] = p;
  }
  return {
    ...state,
    seq,
    synced: true,
    hosts: byId(snap.hosts),
    projects: byId(snap.projects),
    checkouts: byId(snap.checkouts),
    workspaces: byId(snap.workspaces),
    profiles: byId(snap.profiles),
    views: byId(snap.views),
    sessions: byId(snap.sessions),
    tasks: byId(snap.tasks),
    runs: byId(snap.runs),
    automations: byId(snap.automations),
    attention: byId(snap.attention.filter((a) => a.resolvedAt === null)),
    interactions: byId(snap.interactions),
    panels,
    devices: byId(snap.devices),
    dispatchPaused: snap.dispatchPaused,
  };
}

/** Insert or replace an interaction unless a newer revision is already known. */
export function upsertInteraction(state: ClientState, i: Interaction): ClientState {
  const prev = state.interactions[i.id];
  if (prev && prev.revision > i.revision) return state;
  return { ...state, interactions: put(state.interactions, i.id, i) };
}

/** Apply one durable event; events at or below the cursor are ignored. */
export function applyEvent(state: ClientState, event: EventEnvelope): ClientState {
  if (state.seq !== null && event.seq <= state.seq) return state;
  const next = reduceEvent(state, canonicalEventType(event.type) as EventType, event.data as never);
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
    case "workspace.deleted": {
      const d = data as EventData<"workspace.deleted">;
      return { ...state, workspaces: drop(state.workspaces, d.id) };
    }
    case "profile.updated": {
      const d = data as EventData<"profile.updated">;
      return { ...state, profiles: put(state.profiles, d.id, d) };
    }
    case "view.updated": {
      const d = data as EventData<"view.updated">;
      return { ...state, views: put(state.views, d.id, d) };
    }
    case "view.deleted": {
      const d = data as EventData<"view.deleted">;
      return { ...state, views: drop(state.views, d.id) };
    }
    case "profile.deleted": {
      const d = data as EventData<"profile.deleted">;
      return { ...state, profiles: drop(state.profiles, d.id) };
    }
    case "session.updated": {
      const d = data as EventData<"session.updated">;
      return { ...state, sessions: put(state.sessions, d.id, d) };
    }
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
