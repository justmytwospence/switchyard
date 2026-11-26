import {
  type Client,
  type ClientCapability,
  type EventEnvelope,
  type Interaction,
  type Panel,
  projectInteraction,
  projectItem,
  projectPanel,
  type Scope,
  type ServerToClient,
  type SyncState,
  type TranscriptItem,
  type UiReader,
} from "@switchyard/protocol";
import { legacyTerminal, legacyView } from "./legacy.js";

export function projectionIdFor(capabilities: ReadonlySet<ClientCapability>): string {
  return `v1:${[...capabilities].sort().join(",")}`;
}

function readerFor(capabilities: ReadonlySet<ClientCapability>): UiReader {
  return {
    slots: capabilities.has("adapter.slots.v1"),
    cards: capabilities.has("timeline.cards.v1"),
    views: capabilities.has("tool.views.v1"),
    nodes: capabilities.has("ui.nodes.v2"),
    trackers: capabilities.has("adapter.trackers.v1"),
  };
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

function projectEvent(event: EventEnvelope, reader: UiReader, scopes: boolean): EventEnvelope {
  if (!scopes) {
    const legacy = legacyEvent(event);
    if (legacy !== event) return legacy;
  }
  if (event.type === "panel.updated") {
    return { ...event, data: projectPanel(event.data as Panel, reader) };
  }
  if (event.type === "transcript.item") {
    return { ...event, data: projectItem(event.data as TranscriptItem, reader) };
  }
  if (event.type === "interaction.updated") {
    return { ...event, data: projectInteraction(event.data as Interaction, reader) };
  }
  return event;
}

/** Keep durable event seqs intact; only the shape of optional UI data varies by client. */
export function projectClientMessage(
  message: ServerToClient,
  capabilities: ReadonlySet<ClientCapability>,
): ServerToClient {
  const reader = readerFor(capabilities);
  const scopes = capabilities.has("scopes.v1");
  switch (message.type) {
    case "snapshot": {
      const state: SyncState = {
        ...message.state,
        panels: message.state.panels.map((p) => projectPanel(p, reader)),
        // Partial states in tests have no interactions.
        ...(message.state.interactions
          ? { interactions: message.state.interactions.map((i) => projectInteraction(i, reader)) }
          : {}),
      };
      return { ...message, state: scopes ? state : legacyState(state) };
    }
    case "replay":
      return {
        ...message,
        events: message.events.map((event) => projectEvent(event, reader, scopes)),
      };
    case "event":
      return { ...message, event: projectEvent(message.event, reader, scopes) };
    default:
      return message;
  }
}
