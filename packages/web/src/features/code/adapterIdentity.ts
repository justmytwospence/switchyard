import type { Panel } from "@switchyard/protocol";
import { contributionKey } from "@switchyard/protocol";

export function adapterTabId(panel: Panel): `adapter:${string}` {
  return `adapter:${encodeURIComponent(contributionKey(panel.adapterId, panel.contribution!.id))}`;
}

export function adapterCommandName(panel: Panel): string {
  const descriptor = panel.contribution!;
  return descriptor.placement === "slash.command"
    ? `adapter:${panel.adapterId}:${descriptor.name}`
    : "";
}

/** A command's identity includes the descriptor and node, not merely its name. */
export function adapterCommandFingerprint(panel: Panel): string {
  return JSON.stringify([
    panel.sessionId,
    panel.adapterId,
    panel.slot,
    panel.contribution,
    panel.node,
  ]);
}

export function adapterCommandError(
  text: string,
  name: string,
  attachments: number,
): string | null {
  if (attachments) return "Remove attachments before running an adapter command.";
  if (text.trim() !== `/${name}`)
    return "This command uses a form; remove the text after its name.";
  return null;
}
