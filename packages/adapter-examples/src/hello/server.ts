import type { AdapterContext, ServerAdapter, ToolInfo } from "@switchyard/adapter-sdk";
import type { UINode } from "@switchyard/protocol";

/**
 * Example adapter for a fictional Pi extension, `pi-hello`, that registers a `hello` tool and
 * reports its progress with `ctx.ui.setStatus("hello", text)`.
 *
 * - `toolCard`: the `hello` tool becomes a section with a table of its arguments.
 * - `onStatus`: the `hello` status becomes the `hello` panel, as progress when the text carries a
 *   fraction ("2/5") or a percentage ("40%") and as plain text otherwise; clearing the status
 *   clears the panel.
 *
 * It has no runtime imports (`import type` is erased), so the same file works as an adapter
 * shipped inside a Pi package and loaded with Node's type stripping.
 */

export const TOOL_NAME = "hello";
export const STATUS_KEY = "hello";

/** Progress in 0..1 from "3/5" or "40%", else undefined. */
export function progressValue(text: string): number | undefined {
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (frac) {
    const total = Number(frac[2]);
    if (total > 0) return Math.min(1, Number(frac[1]) / total);
  }
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) return Math.min(1, Number(pct[1]) / 100);
  return undefined;
}

const cell = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? ""));

/** The `hello` tool card: one row per argument, plus the result text when it finished. */
export function helloCard(tool: ToolInfo): UINode {
  const args =
    tool.args && typeof tool.args === "object" ? Object.entries(tool.args as object) : [];
  const children: UINode[] = [
    args.length > 0
      ? { t: "table", columns: ["Argument", "Value"], rows: args.map(([k, v]) => [k, cell(v)]) }
      : { t: "text", text: "No arguments", tone: "muted" },
  ];
  if (tool.result !== undefined) {
    children.push({
      t: "text",
      text: resultText(tool.result),
      tone: tool.isError ? "danger" : "default",
    });
  }
  return { t: "section", title: "Hello", children };
}

/** Text content of a Pi tool result (`{content: [{type: "text", text}]}`). */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return cell(result);
  return content
    .filter(
      (c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

/** The `hello` panel for a status text. */
export function helloPanel(text: string): UINode {
  const value = progressValue(text);
  return value === undefined
    ? { t: "text", text }
    : { t: "progress", label: text, value, status: value >= 1 ? "ok" : "running" };
}

const adapter: ServerAdapter = {
  toolCard(tool) {
    return tool.name === TOOL_NAME ? helloCard(tool) : undefined;
  },

  onStatus(key: string, text: string | undefined, ctx: AdapterContext) {
    if (key !== STATUS_KEY) return false;
    const shown = text?.trim() ? text : null;
    ctx.setPanel("hello", shown ? helloPanel(shown) : null, {
      title: "Hello",
      mobileFallback: shown,
    });
    return true;
  },
};

export default adapter;
