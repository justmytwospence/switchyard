import { defineAdapter } from "@switchyard/adapter-sdk";
import { ui } from "@switchyard/protocol";

/**
 * Adapter for @justmytwospence/pi-plan-mode: the plan custom message becomes the "plan" panel,
 * and the plugin's status keys become the "plan-status" table.
 */

export const PLAN_MESSAGE = "plan-mode-plan";
export const STATUS_KEYS = ["workflow-mode", "plan", "plan-exec"] as const;

/** Text of a custom message `content` (a string or text content blocks). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: unknown }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export default defineAdapter({
  onCustomMessage(m, ctx) {
    if (m.customType !== PLAN_MESSAGE) return;
    const text = contentText(m.content).trim();
    ctx.setPanel("plan", text ? ui.markdown(text) : null, {
      title: "Plan",
      mobileFallback: text || null,
    });
  },

  onStatus(key, text, ctx) {
    if (!(STATUS_KEYS as readonly string[]).includes(key)) return false;
    const statuses = { ...(ctx.state.get<Record<string, string>>("status") ?? {}) };
    if (text === undefined || text === "") delete statuses[key];
    else statuses[key] = text;
    ctx.state.set("status", statuses);
    const rows = STATUS_KEYS.filter((k) => statuses[k] !== undefined).map((k) => [k, statuses[k]!]);
    ctx.setPanel("plan-status", rows.length ? ui.table(["Key", "Status"], rows) : null, {
      title: "Plan mode",
    });
    return true;
  },
});
