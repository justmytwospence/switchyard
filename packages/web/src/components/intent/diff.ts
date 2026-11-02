/** Unified diff parsing for DiffView (pure; tested without a DOM). */

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffFile {
  /** Display path (new path, or old path for deletions). */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

function stripPrefix(p: string): string | null {
  const t = p.trim().split("\t")[0]!;
  if (t === "/dev/null") return null;
  return t.replace(/^[ab]\//, "");
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  const consumed = () => {
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  };
  const start = (path = ""): DiffFile => {
    const f: DiffFile = {
      path,
      oldPath: null,
      newPath: null,
      status: "modified",
      additions: 0,
      deletions: 0,
      lines: [],
    };
    files.push(f);
    inHunk = false;
    return f;
  };
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = start(m?.[2] ?? "");
      if (m) {
        file.oldPath = m[1]!;
        file.newPath = m[2]!;
      }
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      if (!file || file.lines.some((l) => l.kind !== "meta")) file = start();
      file.oldPath = stripPrefix(line.slice(4));
      if (file.oldPath === null) file.status = "added";
      continue;
    }
    if (!inHunk && line.startsWith("+++ ") && file) {
      file.newPath = stripPrefix(line.slice(4));
      if (file.newPath === null) file.status = "deleted";
      file.path = file.newPath ?? file.oldPath ?? file.path;
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      if (!file) file = start();
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      inHunk = oldLeft > 0 || newLeft > 0;
      file.lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!file) file = start();
    if (inHunk && line.startsWith("+")) {
      file.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newNo++ });
      file.additions++;
      newLeft--;
      consumed();
    } else if (inHunk && line.startsWith("-")) {
      file.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo++, newLine: null });
      file.deletions++;
      oldLeft--;
      consumed();
    } else if (inHunk && (line.startsWith(" ") || line === "")) {
      file.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldNo++,
        newLine: newNo++,
      });
      oldLeft--;
      newLeft--;
      consumed();
    } else if (line.startsWith("\\")) {
      file.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
    } else {
      // Header lines (index, mode, rename, Binary files ...).
      inHunk = false;
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice(12);
      } else if (line.startsWith("rename to ")) {
        file.status = "renamed";
        file.newPath = line.slice(10);
        file.path = file.newPath;
      } else if (line.startsWith("Binary files")) file.status = "binary";
      file.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
    }
  }
  return files;
}
