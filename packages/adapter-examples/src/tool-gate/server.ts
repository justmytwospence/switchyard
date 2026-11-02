import {
  type Claim,
  defineAdapter,
  InteractionResponseError,
  type PiUiRequest,
} from "@switchyard/adapter-sdk";
import { type UINode, ui } from "@switchyard/protocol";

/**
 * Adapter for @justmytwospence/pi-tool-gate approval prompts:
 * `select("Allow this call?\nAction: ...\nTarget: ...\nHeld: ...\nAgent: ...\n[note]\nRule: ...",
 *   ["Allow once", ...rule options, "Block", "Block with a message"])`.
 * The follow-up input/editor dialogs (block message, rule editing) are left to generic.
 */

export const TITLE_PREFIX = "Allow this call?";
const FIELD_RE = /^\s*(Action|Target|Held|Agent|Rule|Folder|Project saves):\s*(.*)$/;

export interface ParsedApproval {
  rows: [string, string][];
  note: string;
}

export function parseApprovalTitle(title: string): ParsedApproval {
  const rows: [string, string][] = [];
  const note: string[] = [];
  for (const line of title.slice(TITLE_PREFIX.length).split("\n")) {
    const m = FIELD_RE.exec(line);
    if (m) rows.push([m[1]!, m[2]!.trim()]);
    else if (line.trim()) note.push(line.trim());
  }
  return { rows, note: note.join("\n") };
}

function tone(option: string): "primary" | "danger" | "default" {
  if (option === "Allow once") return "primary";
  if (option === "Block" || option === "Block with a message") return "danger";
  return "default";
}

export const optionActionId = (i: number) => `option:${i}`;

export function approvalClaim(req: Extract<PiUiRequest, { method: "select" }>): Claim {
  const { rows, note } = parseApprovalTitle(req.title);
  const action = rows.find(([k]) => k === "Action")?.[1];
  const children: UINode[] = [];
  if (rows.length) children.push(ui.table(["Field", "Value"], rows));
  if (note) children.push(ui.markdown(note));
  children.push(
    ui.actions(req.options.map((o, i) => ({ id: optionActionId(i), label: o, tone: tone(o) }))),
  );
  const title = action ? `${TITLE_PREFIX} ${action}` : TITLE_PREFIX;
  return {
    title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
    presentation: { t: "section", title: TITLE_PREFIX, children },
    toPiResponse(resp) {
      if (resp.kind === "cancel") return { cancelled: true };
      if (resp.kind !== "action") {
        throw new InteractionResponseError(`expected an approval action, got ${resp.kind}`);
      }
      const m = /^option:(\d+)$/.exec(resp.actionId);
      const value = m ? req.options[Number(m[1])] : undefined;
      if (value === undefined) {
        throw new InteractionResponseError(`unknown approval action ${resp.actionId}`);
      }
      return { value };
    },
  };
}

export default defineAdapter({
  claimInteraction(req) {
    if (req.method !== "select" || !req.title.startsWith(TITLE_PREFIX)) return undefined;
    return approvalClaim(req);
  },
});
