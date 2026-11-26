import type { ToolItemData } from "@switchyard/protocol";
import type { DiffFile, DiffLine } from "../../components/intent/diff";

/**
 * What a tool call is, derived from its name and arguments: the one-line label of its transcript
 * row and the detail shown when the row is opened. Verbs exist only for Pi's built-in tools; any
 * other tool keeps its own name. Pure (no React, no store) so the summary and the row agree.
 */

export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "other";

export type ToolDetail =
  | { t: "command"; command: string }
  | { t: "edit"; files: DiffFile[] }
  | { t: "write"; content: string }
  | { t: "read"; range: string | null }
  | { t: "search"; query: string; where: string | null }
  | { t: "args"; rows: [string, string][]; raw: string | null };

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
}

const TARGET_MAX = 120;
const VALUE_MAX = 300;
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
): DiffFile[] {
  if (edits.length === 0) return [];
  const lines: DiffLine[] = [];
  const push = (kind: DiffLine["kind"], text: string) =>
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

function argsDetail(args: unknown): ToolDetail {
  const a = record(args);
  const keys = Object.keys(a);
  if (keys.length === 0) {
    // Arguments that are not an object (a string, a list) have no rows, only their text.
    const text = Array.isArray(args) || typeof args === "string" ? stringifyArgs(args) : "";
    return { t: "args", rows: [], raw: text.trim() ? text : null };
  }
  let needsRaw = false;
  const rows: [string, string][] = keys.map((k) => {
    const v = a[k];
    const scalar = typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    let text: string;
    if (scalar) text = String(v);
    else {
      needsRaw = true;
      try {
        text = JSON.stringify(v) ?? String(v);
      } catch {
        text = String(v);
      }
    }
    if (text.length > VALUE_MAX) needsRaw = true;
    return [k, cut(text, VALUE_MAX)];
  });
  return { t: "args", rows, raw: needsRaw ? stringifyArgs(args) : null };
}

/** The view of one tool call. `cwd` is the session's directory, for shortening paths. */
export function describeTool(
  data: Pick<ToolItemData, "name" | "args">,
  cwd: string | null,
): ToolView {
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
    detail: { t: "args", rows: [], raw: null },
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
        if (s) {
          first = cut(oneLine(s), TARGET_MAX);
          break;
        }
      }
      return { ...base, target: first, detail: argsDetail(data.args) };
    }
  }
}

/** The first words of a tool's row: its verb, or its own name (in mono) when it has none. */
export function toolLabel(
  view: ToolView,
  name: string,
  status: ToolItemData["status"],
): { text: string; mono: boolean } {
  const text = status === "running" ? (view.activeVerb ?? view.verb ?? name) : (view.verb ?? name);
  return { text, mono: view.verb === null };
}
