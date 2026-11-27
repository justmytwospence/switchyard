import { z } from "zod";
import { validateContributionCard } from "./contributions.js";
import { type UINode, UINodeSchema } from "./ui.js";

/** One line of a diff as clients draw it. */
export interface ToolDiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ToolDiffFile {
  /** Display path (new path, or old path for deletions). */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  additions: number;
  deletions: number;
  lines: ToolDiffLine[];
}

type ToolCall = { name: string; args: unknown };
type ToolStatus = "running" | "ok" | "error";

/**
 * What a tool call is, derived from its name and arguments: the one-line label of its transcript
 * row and the detail shown when the row is opened. Verbs exist only for Pi's built-in tools; any
 * other tool keeps its own name. Pure (no React, no store) so the summary and the row agree.
 */

export const TOOL_KINDS = ["read", "edit", "write", "command", "search", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export type ToolDetail =
  | { t: "command"; command: string }
  | { t: "edit"; files: ToolDiffFile[] }
  | { t: "write"; content: string }
  | { t: "read"; range: string | null }
  | { t: "search"; query: string; where: string | null }
  | { t: "args"; value: unknown };

export interface ToolView {
  kind: ToolKind;
  /** Finished: "Read", "Ran". Null shows the tool's name. */
  verb: string | null;
  /** Running: "Reading", "Running". Null with `verb`. */
  activeVerb: string | null;
  /** Shown in mono; "" when unknown. */
  target: string;
  /** Raw path argument of read, edit and write. */
  path: string | null;
  /** Workspace-relative path the Files tab can open. */
  filePath: string | null;
  meta: string[];
  stat: { added: number; removed: number } | null;
  detail: ToolDetail;
  /** `tool.views.v1`: a node from the host or an adapter, shown in place of the typed detail. */
  node: UINode | null;
  /** `tool.views.v1`: the row is not drawn (something else on screen stands for the call). */
  hide: boolean;
}

const TARGET_MAX = 120;
const CONTEXT_LINES = 2;

export function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** A path as the row shows it: relative to the session's directory when it is inside it. */
export function relativePath(path: string, cwd: string | null): { label: string; inside: boolean } {
  const base = cwd ? cwd.replace(/\/+$/, "") : null;
  if (base) {
    if (path === base || path === `${base}/`) return { label: ".", inside: true };
    if (path.startsWith(`${base}/`)) return { label: path.slice(base.length + 1), inside: true };
  }
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path))
    return { label: path, inside: false };
  const label = path.startsWith("./") ? path.slice(2) : path;
  return { label, inside: !(label === ".." || label.startsWith("../")) };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A diff of an edit's replacements, built from its arguments: the changed lines of each
 * replacement with at most two lines of the text around them. There are no line numbers, because
 * the arguments do not say where in the file a replacement lands.
 */
export function editDiffFiles(
  path: string,
  edits: { oldText: string; newText: string }[],
): ToolDiffFile[] {
  if (edits.length === 0) return [];
  const lines: ToolDiffLine[] = [];
  const push = (kind: ToolDiffLine["kind"], text: string) =>
    lines.push({ kind, text, oldLine: null, newLine: null });
  let additions = 0;
  let deletions = 0;
  edits.forEach((edit, i) => {
    const before = splitLines(edit.oldText);
    const after = splitLines(edit.newText);
    const shortest = Math.min(before.length, after.length);
    let p = 0;
    while (p < shortest && before[p] === after[p]) p++;
    let s = 0;
    while (s < shortest - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    if (edits.length > 1) push("hunk", `Edit ${i + 1} of ${edits.length}`);
    for (const l of before.slice(Math.max(0, p - CONTEXT_LINES), p)) push("context", l);
    for (const l of before.slice(p, before.length - s)) {
      push("del", l);
      deletions++;
    }
    for (const l of after.slice(p, after.length - s)) {
      push("add", l);
      additions++;
    }
    for (const l of before.slice(before.length - s, before.length - s + CONTEXT_LINES))
      push("context", l);
  });
  return [{ path, oldPath: path, newPath: path, status: "modified", additions, deletions, lines }];
}

function record(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** A non-empty string argument, trimmed. */
function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function editPairs(a: Record<string, unknown>): { oldText: string; newText: string }[] {
  if (Array.isArray(a.edits)) {
    const out: { oldText: string; newText: string }[] = [];
    for (const e of a.edits) {
      const r = record(e);
      if (typeof r.oldText === "string" && typeof r.newText === "string")
        out.push({ oldText: r.oldText, newText: r.newText });
    }
    if (out.length > 0) return out;
  }
  // Pi before 1.6 took one replacement at the top level.
  if (typeof a.oldText === "string" && typeof a.newText === "string")
    return [{ oldText: a.oldText, newText: a.newText }];
  return [];
}

export function looksLikeToolPayload(text: string): boolean {
  const s = text.trimStart();
  return (
    /^```json[\t ]*(?:\r?\n|$)/i.test(s) ||
    s.startsWith("{") ||
    (s.startsWith("[") && !/^\[(?!(?:true|false|null)\])[A-Za-z][A-Za-z0-9 _-]*\](?=\s|$)/.test(s))
  );
}

/** The view of one tool call. `cwd` is the session's directory, for shortening paths. */
export function describeTool(data: ToolCall, cwd: string | null): ToolView {
  const a = record(data.args);
  const base: ToolView = {
    kind: "other",
    verb: null,
    activeVerb: null,
    target: "",
    path: null,
    filePath: null,
    meta: [],
    stat: null,
    detail: { t: "args", value: data.args },
    node: null,
    hide: false,
  };
  const rawPath = str(a.path);
  const rel = rawPath ? relativePath(rawPath, cwd) : null;
  const pathLabel = rel?.label ?? "";
  const file = {
    target: pathLabel,
    path: rawPath,
    filePath: rel?.inside && rel.label !== "." && rel.label !== "" ? rel.label : null,
  };

  switch (data.name) {
    case "read": {
      const offset = num(a.offset);
      const limit = num(a.limit);
      const range =
        offset !== null && limit !== null
          ? `lines ${offset}–${offset + limit - 1}`
          : offset !== null
            ? `from line ${offset}`
            : limit !== null
              ? `first ${limit} lines`
              : null;
      return {
        ...base,
        ...file,
        kind: "read",
        verb: "Read",
        activeVerb: "Reading",
        meta: range ? [range] : [],
        detail: { t: "read", range },
      };
    }
    case "bash":
    case "powershell": {
      const command = typeof a.command === "string" ? a.command : "";
      const lines = command
        .split("\n")
        .map(oneLine)
        .filter((l) => l !== "");
      const more = lines.length - 1;
      return {
        ...base,
        kind: "command",
        verb: "Ran",
        activeVerb: "Running",
        target: lines[0] ?? "",
        meta: more > 0 ? [`+${more} ${more === 1 ? "line" : "lines"}`] : [],
        detail: { t: "command", command },
      };
    }
    case "edit": {
      const edits = editPairs(a);
      const files = editDiffFiles(pathLabel, edits);
      const f = files[0];
      return {
        ...base,
        ...file,
        kind: "edit",
        verb: "Edited",
        activeVerb: "Editing",
        meta: edits.length > 1 ? [`${edits.length} edits`] : [],
        stat: f ? { added: f.additions, removed: f.deletions } : null,
        detail: { t: "edit", files },
      };
    }
    case "write": {
      const content = typeof a.content === "string" ? a.content : "";
      const added = splitLines(content).length;
      return {
        ...base,
        ...file,
        kind: "write",
        verb: "Wrote",
        activeVerb: "Writing",
        stat: added > 0 ? { added, removed: 0 } : null,
        detail: { t: "write", content },
      };
    }
    case "grep":
    case "find": {
      const query = str(a.pattern) ?? "";
      const where = rawPath ? pathLabel : null;
      const meta = where ? [`in ${where}`] : [];
      const glob = data.name === "grep" ? str(a.glob) : null;
      if (glob) meta.push(glob);
      return {
        ...base,
        kind: "search",
        verb: data.name === "grep" ? "Searched" : "Searched files",
        activeVerb: data.name === "grep" ? "Searching" : "Searching files",
        target: query,
        meta,
        detail: { t: "search", query, where },
      };
    }
    case "ls": {
      const target = pathLabel || ".";
      return {
        ...base,
        kind: "search",
        verb: "Listed",
        activeVerb: "Listing",
        target,
        detail: { t: "search", query: target, where: null },
      };
    }
    default: {
      let first = "";
      for (const v of Object.values(a)) {
        const s = str(v);
        if (s && !looksLikeToolPayload(s)) {
          first = cut(oneLine(s), TARGET_MAX);
          break;
        }
      }
      return { ...base, target: first };
    }
  }
}

/** The first words of a tool's row: its verb, or its own name (in mono) when it has none. */
export function toolLabel(
  view: ToolView,
  name: string,
  status: ToolStatus,
): { text: string; mono: boolean } {
  const text = status === "running" ? (view.activeVerb ?? view.verb ?? name) : (view.verb ?? name);
  return { text, mono: view.verb === null };
}

// ---------------------------------------------------------------------------
// `tool.views.v1`: what a host or an adapter says about a call

/**
 * A tool call's view as it travels with the transcript item. Every field is optional and
 * overrides what `describeTool` derives from the name and arguments: the host fills it from
 * Pi's result (a real diff, an exit code), and an adapter's `toolView` hook from what the tool
 * means. A reader that does not know it draws the derived row.
 */
export const ToolViewData = z.object({
  kind: z.enum(TOOL_KINDS).optional(),
  /** Finished: "Asked", "Updated todo". */
  verb: z.string().min(1).max(40).optional(),
  /** Running: "Asking". Defaults to `verb`. */
  activeVerb: z.string().min(1).max(40).optional(),
  /** What the call acted on, shown in mono. */
  target: z.string().max(500).optional(),
  /** Short facts after the target ("3 items", "exit 1"). */
  meta: z.array(z.string().min(1).max(80)).max(6).optional(),
  /** Lines added and removed. */
  stat: z.object({ added: z.number().int().min(0), removed: z.number().int().min(0) }).optional(),
  /** Shown when the row is opened, in place of the typed detail. No forms or confirms. */
  detail: UINodeSchema.optional(),
  /** Do not draw the row: a dock question or a tracker already stands for this call. */
  hide: z.boolean().optional(),
});
export type ToolViewData = z.infer<typeof ToolViewData>;

/** Parse and bound a view from an adapter. Throws on an invalid one. */
export function validateToolView(input: unknown): ToolViewData {
  const view = ToolViewData.strict().parse(input);
  if (view.detail !== undefined) validateContributionCard(view.detail);
  return view;
}

/** `over` on top of `base`, field by field. */
export function mergeToolViewData(
  base: ToolViewData | undefined,
  over: ToolViewData | undefined,
): ToolViewData | undefined {
  if (!base) return over;
  if (!over) return base;
  return { ...base, ...over };
}

/** The derived view with a host or adapter view applied. */
export function applyToolView(view: ToolView, data: ToolViewData | null | undefined): ToolView {
  if (!data) return view;
  return {
    ...view,
    kind: data.kind ?? view.kind,
    verb: data.verb ?? view.verb,
    activeVerb: data.activeVerb ?? (data.verb !== undefined ? data.verb : view.activeVerb),
    target: data.target ?? view.target,
    meta: data.meta ?? view.meta,
    stat: data.stat ?? view.stat,
    node: data.detail ?? view.node,
    hide: data.hide ?? view.hide,
  };
}

/**
 * Pi's edit result (`details.diff`: one line per row as `+12 text`, `-12 text`, ` 12 text`, and
 * `   ...` for skipped lines) as a unified patch with real line numbers.
 */
export function piEditDiffToPatch(
  path: string,
  diff: string,
): { patch: string; added: number; removed: number } | null {
  type Row = { sign: "+" | "-" | " "; n: number; text: string };
  const hunks: Row[][] = [];
  let cur: Row[] = [];
  for (const line of diff.split("\n")) {
    const m = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
    if (!m) {
      if (cur.length) hunks.push(cur);
      cur = [];
      continue;
    }
    cur.push({ sign: m[1] as Row["sign"], n: Number(m[2]), text: m[3]! });
  }
  if (cur.length) hunks.push(cur);
  let added = 0;
  let removed = 0;
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const rows of hunks) {
    // Context and removed rows carry the old line number, added rows the new one.
    const delta = added - removed;
    const first = rows[0]!;
    const oldStart = first.sign === "+" ? first.n - delta : first.n;
    const newStart = first.sign === "+" ? first.n : first.n + delta;
    const olds = rows.filter((r) => r.sign !== "+").length;
    const news = rows.filter((r) => r.sign !== "-").length;
    out.push(`@@ -${oldStart},${olds} +${newStart},${news} @@`);
    for (const r of rows) {
      out.push(`${r.sign}${r.text}`);
      if (r.sign === "+") added++;
      else if (r.sign === "-") removed++;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { patch: `${out.join("\n")}\n`, added, removed };
}

function resultRecord(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

/**
 * What the host knows about a built-in tool call once Pi has its result: the edit's real diff
 * and a command's exit code. Undefined when the result adds nothing to the derived view.
 */
export function builtinToolView(
  tool: { name: string; args: unknown; result?: unknown; isError?: boolean; details?: unknown },
  cwd: string | null,
): ToolViewData | undefined {
  if (tool.result === undefined) return undefined;
  if (tool.name === "edit" && tool.isError !== true) {
    const diff = resultRecord(tool.details).diff;
    const path = describeTool(tool, cwd).target;
    if (typeof diff !== "string" || !path) return undefined;
    const real = piEditDiffToPatch(path, diff);
    if (!real) return undefined;
    return {
      stat: { added: real.added, removed: real.removed },
      detail: { t: "diff", patch: real.patch },
    };
  }
  if (tool.name === "bash" || tool.name === "powershell") {
    const structured = resultRecord(resultRecord(tool.result).structuredContent).exit_code;
    let code = typeof structured === "number" ? structured : null;
    if (code === null) {
      const content = resultRecord(tool.result).content;
      const text = Array.isArray(content)
        ? content.map((c) => String(resultRecord(c).text ?? "")).join("\n")
        : "";
      const m = /Command exited with code (\d+)/.exec(text);
      if (m) code = Number(m[1]);
    }
    if (code === null || code === 0) return undefined;
    const meta = describeTool(tool, cwd).meta;
    return { meta: [...meta, `exit ${code}`] };
  }
  return undefined;
}
