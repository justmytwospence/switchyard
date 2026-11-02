import type { Field, UINode } from "@switchyard/protocol";

/**
 * Plain-text rendering of portable UI trees for the terminal. Interactive nodes (form, confirm,
 * actions) render as a description here; `interaction.ts` turns them into controls.
 */

const INDENT = "  ";

function indent(lines: string[], prefix = INDENT): string[] {
  return lines.map((l) => (l ? prefix + l : l));
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Render a markdown string as plain text: keeps the text, drops fence markers. */
export function markdownToText(md: string): string[] {
  const out: string[] = [];
  for (const line of splitLines(md)) {
    if (/^\s*```/.test(line)) continue;
    out.push(line.replace(/^(#{1,6})\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"));
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function table(columns: string[], rows: string[][]): string[] {
  const widths = columns.map((c, i) =>
    Math.min(40, Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length))),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        const v = c.length > w ? `${c.slice(0, Math.max(0, w - 1))}…` : c;
        return v.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  const out = [fmt(columns), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) out.push(fmt(columns.map((_, i) => r[i] ?? "")));
  return out;
}

export function describeField(field: Field): string {
  switch (field.kind) {
    case "select":
      return `${field.label} (choose one)`;
    case "multiselect":
      return `${field.label} (choose any)`;
    case "text":
      return field.label;
  }
}

/** Render a UI tree as text lines. `skip` omits one node (the interactive control shown separately). */
export function uiToText(node: UINode, skip?: UINode): string[] {
  if (node === skip) return [];
  switch (node.t) {
    case "text":
      return splitLines(node.text);
    case "markdown":
      return markdownToText(node.text);
    case "code":
      return indent(splitLines(node.text.replace(/\n$/, "")));
    case "diff":
      return splitLines(node.patch.replace(/\n$/, ""));
    case "list":
      return node.items.flatMap((item, i) => {
        const lines = uiToText(item, skip);
        if (lines.length === 0) return [];
        const bullet = node.ordered ? `${i + 1}. ` : "- ";
        return [bullet + lines[0], ...indent(lines.slice(1), " ".repeat(bullet.length))];
      });
    case "table":
      return table(node.columns, node.rows);
    case "section": {
      const body = node.children.flatMap((c) => uiToText(c, skip));
      return node.title ? [node.title, ...indent(body)] : body;
    }
    case "tabs":
      return node.tabs.flatMap((tab) => [
        `[${tab.label}]`,
        ...indent(tab.children.flatMap((c) => uiToText(c, skip))),
      ]);
    case "progress": {
      const pct = node.value === undefined ? "" : ` ${Math.round(node.value * 100)}%`;
      const status = node.status ? ` (${statusWord(node.status)})` : "";
      return [`${node.label}${pct}${status}`];
    }
    case "ref":
      return [refText(node)];
    case "form":
      return node.fields.map((f) => `* ${describeField(f)}`);
    case "confirm":
      return [node.message, `[${node.confirmLabel}] [${node.cancelLabel}]`];
    case "actions":
      return [node.actions.map((a) => `[${a.label}]`).join(" ")];
  }
}

function statusWord(s: "running" | "ok" | "error"): string {
  return s === "running" ? "running" : s === "ok" ? "done" : "failed";
}

function refText(node: Extract<UINode, { t: "ref" }>): string {
  switch (node.ref.kind) {
    case "file":
      return `${node.label} (${node.ref.path})`;
    case "session":
      return `${node.label} (session ${node.ref.sessionId})`;
    case "task":
      return `${node.label} (task ${node.ref.taskId})`;
    case "native_session":
      return `${node.label} (${node.ref.sessionFile})`;
  }
}

/** The first interactive node in document order, preferring a form, then confirm, then actions. */
export function findControl(
  node: UINode,
): Extract<UINode, { t: "form" | "confirm" | "actions" }> | null {
  const found: Extract<UINode, { t: "form" | "confirm" | "actions" }>[] = [];
  const walk = (n: UINode) => {
    if (n.t === "form" || n.t === "confirm" || n.t === "actions") found.push(n);
    if (n.t === "list") n.items.forEach(walk);
    else if (n.t === "section") n.children.forEach(walk);
    else if (n.t === "tabs") for (const tab of n.tabs) tab.children.forEach(walk);
  };
  walk(node);
  return (
    found.find((n) => n.t === "form") ??
    found.find((n) => n.t === "confirm") ??
    found.find((n) => n.t === "actions") ??
    null
  );
}
