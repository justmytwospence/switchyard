import { defineAdapter } from "@switchyard/adapter-sdk";
import { type UINode, ui } from "@switchyard/protocol";

/** Adapter for @justmytwospence/pi-todo: `todo` tool `details.tasks` -> the "todo" panel. */

export const TOOL_NAME = "todo";

export interface TodoItem {
  title: string;
  status: string;
}

const pick = (o: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");

/** Normalize task records; tolerant of title/subject/content and status/state field names. */
export function todoItems(tasks: unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const status =
      pick(o, ["status", "state"]) ??
      (o.done === true || o.completed === true ? "completed" : "pending");
    if (status === "deleted") continue;
    out.push({
      title: pick(o, ["title", "subject", "content", "text", "description"]) ?? "(untitled)",
      status,
    });
  }
  return out;
}

function mark(status: string): string {
  if (status === "completed" || status === "done") return "[x]";
  if (status === "in_progress" || status === "active") return "[~]";
  if (status === "pending" || status === "todo") return "[ ]";
  return `[${status}]`;
}

export function todoPanel(items: TodoItem[]): UINode | null {
  if (items.length === 0) return null;
  return ui.list(
    items.map((i) =>
      ui.text(
        `${mark(i.status)} ${i.title}`,
        i.status === "completed" || i.status === "done" ? "muted" : "default",
      ),
    ),
  );
}

export default defineAdapter({
  onToolEnd(e, ctx) {
    if (e.name !== TOOL_NAME) return;
    const details = (e.details ?? (e.result as { details?: unknown } | null)?.details) as
      | { tasks?: unknown }
      | undefined;
    if (!Array.isArray(details?.tasks)) return;
    const items = todoItems(details.tasks);
    ctx.setPanel("todo", todoPanel(items), {
      title: "Todo",
      mobileFallback: items.map((i) => `${mark(i.status)} ${i.title}`).join("\n") || null,
    });
  },
});
