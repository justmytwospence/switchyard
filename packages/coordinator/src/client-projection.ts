import type {
  Client,
  ClientCapability,
  EventEnvelope,
  Panel,
  Scope,
  ServerToClient,
  SyncState,
  TranscriptItem,
} from "@switchyard/protocol";
import { legacyTerminal, legacyView } from "./legacy.js";

export function projectionIdFor(capabilities: ReadonlySet<ClientCapability>): string {
  return `v1:${[...capabilities].sort().join(",")}`;
}

function projectPanel(panel: Panel, slots: boolean): Panel {
  if (slots || !panel.contribution) return panel;
  const { contribution: _contribution, state: _state, ...legacy } = panel;
  return {
    ...legacy,
    webRenderer: false,
    node: panel.node === null ? null : { t: "text", text: panel.mobileFallback ?? panel.title },
  };
}

function projectItem(item: TranscriptItem, cards: boolean): TranscriptItem {
  if (cards || item.kind !== "notice") return item;
  const { customType: _customType, card: _card, adapterId: _adapterId, ...data } = item.data;
  return { ...item, data };
}

/**
 * COMPAT(scopes-rename): remove after 2027-03-01. A client without `scopes.v1` (0.20) reads
 * scopes as views and clients as terminals.
 */
function legacyEvent(event: EventEnvelope): EventEnvelope {
  const as = (type: string, data: unknown) =>
    ({ ...event, type, data }) as unknown as EventEnvelope;
  switch (event.type) {
    case "scope.updated":
      return as("view.updated", legacyView(event.data as Scope));
    case "scope.deleted":
      return as("view.deleted", event.data);
    case "client.updated":
      return as("terminal.updated", legacyTerminal(event.data as Client));
    case "client.deleted":
      return as("terminal.deleted", event.data);
    default:
      return event;
  }
}

function legacyState(state: SyncState): SyncState {
  const { scopes, clients, ...rest } = state;
  return {
    ...rest,
    views: scopes.map(legacyView),
    terminals: clients.map(legacyTerminal),
  } as unknown as SyncState;
}

function projectEvent(
  event: EventEnvelope,
  slots: boolean,
  cards: boolean,
  scopes: boolean,
): EventEnvelope {
  if (!scopes) {
    const legacy = legacyEvent(event);
    if (legacy !== event) return legacy;
  }
  if (event.type === "panel.updated") {
    return { ...event, data: projectPanel(event.data as Panel, slots) };
  }
  if (event.type === "transcript.item") {
    return { ...event, data: projectItem(event.data as TranscriptItem, cards) };
  }
  return event;
}

/** Keep durable event seqs intact; only the shape of optional UI data varies by client. */
export function projectClientMessage(
  message: ServerToClient,
  capabilities: ReadonlySet<ClientCapability>,
): ServerToClient {
  const slots = capabilities.has("adapter.slots.v1");
  const cards = capabilities.has("timeline.cards.v1");
  const scopes = capabilities.has("scopes.v1");
  switch (message.type) {
    case "snapshot": {
      const state: SyncState = {
        ...message.state,
        panels: message.state.panels.map((p) => projectPanel(p, slots)),
      };
      return { ...message, state: scopes ? state : legacyState(state) };
    }
    case "replay":
      return {
        ...message,
        events: message.events.map((event) => projectEvent(event, slots, cards, scopes)),
      };
    case "event":
      return { ...message, event: projectEvent(message.event, slots, cards, scopes) };
    default:
      return message;
  }
}
