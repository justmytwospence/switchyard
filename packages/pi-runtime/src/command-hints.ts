import { readFile } from "node:fs/promises";

/** The `argument-hint` frontmatter value of a prompt template, or null. */
export function parseArgumentHint(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  for (const line of lines.slice(1, end)) {
    const m = /^argument-hint:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[1] ?? "").trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) {
      value = value.slice(1, -1).trim();
    }
    return value ? value.slice(0, 80) : null;
  }
  return null;
}

export async function readArgumentHint(path: string): Promise<string | null> {
  if (!path.endsWith(".md")) return null;
  try {
    return parseArgumentHint(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
