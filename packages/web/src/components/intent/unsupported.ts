import type { Interaction, UINode } from "@switchyard/protocol";

/** What actually happened when an extension opened a terminal-only `ctx.ui.custom()` dialog. */
export const UNSUPPORTED_COPY =
  "An extension opened a terminal-only dialog. In RPC mode Pi gave it no answer, so the extension continued without one.";

export interface UnsupportedAction {
  id: "abort" | "message";
  label: string;
  tone: "primary" | "secondary" | "danger";
}

const DEFAULT_ACTIONS: UnsupportedAction[] = [
  { id: "abort", label: "Stop the run", tone: "danger" },
  { id: "message", label: "Send a message to the agent", tone: "primary" },
];

function findActions(node: UINode): Extract<UINode, { t: "actions" }> | null {
  if (node.t === "actions") return node;
  if (node.t === "section") {
    for (const c of node.children) {
      const found = findActions(c);
      if (found) return found;
    }
  }
  return null;
}

export interface UnsupportedView {
  /** True until a person chose one of the alternatives. */
  answerable: boolean;
  actions: UnsupportedAction[];
  copy: string;
}

export function isUnsupported(i: Interaction): boolean {
  return i.state === "unsupported" || i.source.kind === "unsupported_custom";
}

/** The alternatives the host offers for an unsupported dialog (stop the run, message). */
export function unsupportedView(i: Interaction): UnsupportedView {
  const node = findActions(i.presentation);
  const offered = (node?.actions ?? [])
    .filter(
      (a): a is typeof a & { id: "abort" | "message" } => a.id === "abort" || a.id === "message",
    )
    .map((a) => ({
      id: a.id,
      label: a.label,
      tone: (a.tone === "default"
        ? "secondary"
        : (a.tone ?? (a.id === "abort" ? "danger" : "primary"))) as UnsupportedAction["tone"],
    }));
  return {
    answerable: i.state === "unsupported" && i.resolution === null,
    actions: offered.length > 0 ? offered : DEFAULT_ACTIONS,
    copy: UNSUPPORTED_COPY,
  };
}

/** A follow-up while Pi is still working queues behind the current turn. */
export function messageMode(runtime: string | undefined): "prompt" | "followUp" {
  return runtime === "running" || runtime === "waiting_input" ? "followUp" : "prompt";
}
