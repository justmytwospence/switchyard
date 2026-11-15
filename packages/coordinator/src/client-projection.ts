import type {
  ClientCapability,
  EventEnvelope,
  Panel,
  ServerToClient,
  SyncState,
  TranscriptItem,
} from "@switchyard/protocol";

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

function projectEvent(event: EventEnvelope, slots: boolean, cards: boolean): EventEnvelope {
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
  switch (message.type) {
    case "snapshot": {
      const state: SyncState = {
        ...message.state,
        panels: message.state.panels.map((p) => projectPanel(p, slots)),
      };
      return { ...message, state };
    }
    case "replay":
      return {
        ...message,
        events: message.events.map((event) => projectEvent(event, slots, cards)),
      };
    case "event":
      return { ...message, event: projectEvent(message.event, slots, cards) };
    default:
      return message;
  }
}
