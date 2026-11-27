import { looksLikeToolPayload } from "@switchyard/protocol";

export type ToolPayloadPart =
  | { kind: "data"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "pending" | "unreadable" | "omitted" };

const LIMIT = 64 * 1024;

/** Decode only recognized machine-data boundaries, never arbitrary authored text. */
export function toolPayloadParts(text: string, running: boolean): ToolPayloadPart[] {
  if (!text) return [];
  if (!looksLikeToolPayload(text)) return [{ kind: "text", text }];
  const parts: ToolPayloadPart[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = pos + (text.slice(pos).match(/^\s*/)?.[0].length ?? 0);
    if (!looksLikeToolPayload(text.slice(start))) {
      parts.push({ kind: "text", text: text.slice(pos) });
      break;
    }
    if (start >= LIMIT || parts.filter((p) => p.kind === "data").length >= 20) {
      parts.push({ kind: "omitted" });
      break;
    }
    const remaining = text.slice(start, LIMIT);
    const fence = /^```json[\t ]*\r?\n/i.exec(remaining);
    let end = -1;
    let json = "";
    if (fence) {
      const close = /^```[\t ]*(?=\r?$)/m.exec(remaining.slice(fence[0].length));
      if (close) {
        json = remaining.slice(fence[0].length, fence[0].length + close.index);
        end = start + fence[0].length + close.index + close[0].length;
      }
    } else if (remaining[0] === "{" || remaining[0] === "[") {
      const stack: string[] = [];
      let quoted = false;
      let escaped = false;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{" || c === "[") stack.push(c);
        else if (c === "}" || c === "]") {
          if (stack.pop() !== (c === "}" ? "{" : "[")) break;
          if (!stack.length) {
            end = start + i + 1;
            json = remaining.slice(0, i + 1);
            break;
          }
        }
      }
    }
    if (end >= 0 && end < text.length && !/^[\t ]*(?:\r?\n|$)/.test(text.slice(end))) {
      parts.push({ kind: "text", text: text.slice(pos) });
      break;
    }
    if (end >= 0) {
      try {
        const value: unknown = JSON.parse(json);
        if (value === null || typeof value !== "object") throw new Error("not a container");
        parts.push({ kind: "data", value });
        pos = end;
        if (!text.slice(pos).trim()) break;
        continue;
      } catch {
        /* handled as a recognized malformed candidate below */
      }
    }
    if (text.length > LIMIT && end < 0) {
      parts.push({ kind: "omitted" });
      break;
    }
    const plausible =
      !!fence ||
      /^```json[\t ]*(?:\r?\n|$)/i.test(remaining) ||
      /^\{\s*"/.test(remaining) ||
      (end < 0 && /^\[\s*(?:"|\[|\{|\d|-\d|true|false|null)/.test(remaining));
    if (running && end < 0 && (plausible || /^[{[]/.test(remaining)))
      parts.push({ kind: "pending" });
    else if (plausible) parts.push({ kind: "unreadable" });
    else parts.push({ kind: "text", text: text.slice(pos) });
    break;
  }
  return parts;
}
