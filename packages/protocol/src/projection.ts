import { trackerText } from "./contributions.js";
import type { Interaction, Panel, TranscriptItem } from "./entities.js";
import { downgradeUINode, type UINode } from "./ui.js";

/**
 * Host feature, negotiated in `welcome`: the coordinator reads tool views, the v2 UI nodes, the
 * tracker and badge placements and an interaction's kind and tool call. A host whose coordinator
 * did not echo it sends the same events in their earlier shape (`projectHostEvent`).
 */
export const ADAPTER_CONTRACT_FEATURE = "adapterContract.v2";
/** Host feature: the host answers `session.clearQueue`. */
export const QUEUE_CLEAR_FEATURE = "queueClear.v1";

/** What a reader of adapter-made UI understands. */
export interface UiReader {
  /** Typed contributions (`adapter.slots.v1`). */
  slots: boolean;
  /** Custom message cards (`timeline.cards.v1`). */
  cards: boolean;
  /** `ToolItemData.view` (`tool.views.v1`). */
  views: boolean;
  /** checklist, facts, rows, badge, `section.open` and URL refs (`ui.nodes.v2`). */
  nodes: boolean;
  /** `composer.tracker` and `session.badge` (`adapter.trackers.v1`). */
  trackers: boolean;
}

export const FULL_UI_READER: UiReader = {
  slots: true,
  cards: true,
  views: true,
  nodes: true,
  trackers: true,
};
/** A reader from before contract v2: typed contributions and cards, nothing newer. */
export const V1_UI_READER: UiReader = {
  slots: true,
  cards: true,
  views: false,
  nodes: false,
  trackers: false,
};

const node = (n: UINode, reader: UiReader): UINode => (reader.nodes ? n : downgradeUINode(n));

export function projectPanel(panel: Panel, reader: UiReader): Panel {
  let out = panel;
  if (out.node !== null && !reader.nodes) {
    const n = downgradeUINode(out.node);
    if (n !== out.node) out = { ...out, node: n };
  }
  const placement = out.contribution?.placement;
  if (out.contribution && !reader.trackers && placement === "session.badge") {
    // Nothing older can show a badge: the panel is removed for that reader.
    const { contribution: _c, state: _s, ...rest } = out;
    return { ...rest, node: null, webRenderer: false };
  }
  if (out.contribution && !reader.trackers && placement === "composer.tracker") {
    const { tracker, actionId: _a, ...descriptor } = out.contribution;
    out = {
      ...out,
      contribution: { ...descriptor, placement: "composer.pill" },
      node:
        out.node === null
          ? null
          : { t: "text", text: trackerText(out.title, tracker).slice(0, 200) },
    };
  }
  if (reader.slots || !out.contribution) return out;
  const { contribution: _contribution, state: _state, ...legacy } = out;
  return {
    ...legacy,
    webRenderer: false,
    node: out.node === null ? null : { t: "text", text: out.mobileFallback ?? out.title },
  };
}

export function projectItem(item: TranscriptItem, reader: UiReader): TranscriptItem {
  if (item.kind === "tool") {
    let data = item.data;
    if (data.view !== undefined) {
      if (!reader.views) {
        const { view: _view, ...rest } = data;
        data = rest;
      } else if (data.view.detail !== undefined && !reader.nodes) {
        const detail = downgradeUINode(data.view.detail);
        if (detail !== data.view.detail) data = { ...data, view: { ...data.view, detail } };
      }
    }
    if (data.card !== null && !reader.nodes) {
      const card = downgradeUINode(data.card);
      if (card !== data.card) data = { ...data, card };
    }
    return data === item.data ? item : { ...item, data };
  }
  if (item.kind !== "notice") return item;
  if (!reader.cards) {
    const { customType: _customType, card: _card, adapterId: _adapterId, ...data } = item.data;
    return { ...item, data };
  }
  if (item.data.card && !reader.nodes) {
    const card = downgradeUINode(item.data.card);
    if (card !== item.data.card) return { ...item, data: { ...item.data, card } };
  }
  return item;
}

export function projectInteraction(interaction: Interaction, reader: UiReader): Interaction {
  if (reader.nodes) return interaction;
  const presentation = node(interaction.presentation, reader);
  return presentation === interaction.presentation ? interaction : { ...interaction, presentation };
}

/** A host event as a coordinator from before contract v2 reads it. */
export function projectHostEvent<E extends { type: string; data: unknown }>(event: E): E {
  switch (event.type) {
    case "panel.updated":
      return { ...event, data: projectPanel(event.data as Panel, V1_UI_READER) };
    case "transcript.item":
      return { ...event, data: projectItem(event.data as TranscriptItem, V1_UI_READER) };
    case "interaction.updated": {
      const { kind: _kind, toolCallId: _toolCallId, ...rest } = event.data as Interaction;
      return { ...event, data: projectInteraction(rest as Interaction, V1_UI_READER) };
    }
    default:
      return event;
  }
}
