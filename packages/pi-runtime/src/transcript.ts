import { newId, type ToolItemData, type TranscriptItem } from "@switchyard/protocol";

/** Maximum characters of tool output kept on a tool item. */
export const TOOL_OUTPUT_LIMIT = 32 * 1024;
const SUMMARY_LIMIT = 120;

type Kind = TranscriptItem["kind"];
export type ItemData<K extends Kind> = Extract<TranscriptItem, { kind: K }>["data"];

/** Build one transcript item. */
export function makeItem<K extends Kind>(
  kind: K,
  data: ItemData<K>,
  meta: { id: string; sessionId: string; order: number; at: string },
): TranscriptItem {
  return { ...meta, kind, data } as TranscriptItem;
}

/** Text of a message `content` (string or content blocks); counts images. */
export function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") images++;
  }
  return { text: parts.join("\n"), images };
}

/** Tool result content (`{content:[...]}` or a string) to plain text, capped. */
export function toolOutputText(result: unknown): string {
  let text = "";
  if (typeof result === "string") text = result;
  else if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    text = contentText(r.content).text;
  }
  if (text.length > TOOL_OUTPUT_LIMIT) {
    text = `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (truncated, ${text.length} characters)`;
  }
  return text;
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

/** Generic one-line tool summary: the tool name plus its first string argument, max 120 chars. */
export function genericToolSummary(name: string, args: unknown): string {
  let first: string | undefined;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        first = value;
        break;
      }
    }
  }
  return truncate(first ? `${name} ${first}` : name, SUMMARY_LIMIT);
}

export function initialToolData(
  toolCallId: string,
  name: string,
  args: unknown,
  startedAt: string,
): ToolItemData {
  return {
    toolCallId,
    name,
    status: "running",
    args: args ?? {},
    summary: genericToolSummary(name, args),
    output: "",
    startedAt,
    durationMs: null,
    card: null,
    adapterId: null,
  };
}

export interface MessagesToItemsOptions {
  sessionId: string;
  /** First order number (default 0). */
  startOrder?: number;
  newItemId?: () => string;
  /** Timestamp for items whose message has none. */
  fallbackAt?: string;
}

function isoFrom(ts: unknown, fallback: string): string {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return fallback;
}

/**
 * Map Pi `AgentMessage`s (from `get_messages` or session file `message` entries) to transcript
 * items, for attach, resume and read-only views. Tool calls pair with their tool results.
 */
export function messagesToItems(
  messages: unknown[],
  opts: MessagesToItemsOptions,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const newItemId = opts.newItemId ?? (() => newId("itm"));
  const fallbackAt = opts.fallbackAt ?? new Date().toISOString();
  let order = opts.startOrder ?? 0;
  const tools = new Map<string, TranscriptItem & { kind: "tool" }>();
  const push = <K extends Kind>(kind: K, data: ItemData<K>, at: string): TranscriptItem => {
    const item = makeItem(kind, data, {
      id: newItemId(),
      sessionId: opts.sessionId,
      order: order++,
      at,
    });
    items.push(item);
    return item;
  };

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, any>;
    const at = isoFrom(m.timestamp, fallbackAt);
    switch (m.role) {
      case "user": {
        const { text, images } = contentText(m.content);
        push("user", images > 0 ? { text, images } : { text }, at);
        break;
      }
      case "assistant": {
        const content: any[] = Array.isArray(m.content) ? m.content : [];
        for (const block of content) {
          if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            push("thinking", { text: block.thinking }, at);
          } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
            push("assistant", { text: block.text }, at);
          } else if (block?.type === "toolCall" && typeof block.id === "string") {
            const item = push(
              "tool",
              initialToolData(block.id, String(block.name ?? "tool"), block.arguments, at),
              at,
            ) as TranscriptItem & { kind: "tool" };
            tools.set(block.id, item);
          }
        }
        if ((m.stopReason === "error" || m.stopReason === "aborted") && m.errorMessage) {
          push(
            "notice",
            {
              level: m.stopReason === "aborted" ? "warning" : "error",
              text: String(m.errorMessage),
            },
            at,
          );
        }
        break;
      }
      case "toolResult": {
        const item = tools.get(String(m.toolCallId));
        const output = toolOutputText(m);
        if (item) {
          item.data.status = m.isError ? "error" : "ok";
          item.data.output = output;
          item.data.durationMs = typeof m.durationMs === "number" ? m.durationMs : null;
        } else {
          const data = initialToolData(String(m.toolCallId), String(m.toolName ?? "tool"), {}, at);
          data.status = m.isError ? "error" : "ok";
          data.output = output;
          push("tool", data, at);
        }
        break;
      }
      case "custom": {
        if (m.display === false) break;
        const { text } = contentText(m.content);
        if (text) push("notice", { level: "info", text }, at);
        break;
      }
      case "bashExecution": {
        const output = typeof m.output === "string" ? m.output : "";
        push("system", { text: `$ ${m.command}\n${output}`.trimEnd() }, at);
        break;
      }
      case "compactionSummary":
        push("notice", { level: "info", text: `Context compacted: ${m.summary ?? ""}`.trim() }, at);
        break;
      case "branchSummary":
        push("notice", { level: "info", text: `Branch summary: ${m.summary ?? ""}`.trim() }, at);
        break;
      default:
        // system prompt messages and unknown roles are not shown
        break;
    }
  }
  return items;
}
