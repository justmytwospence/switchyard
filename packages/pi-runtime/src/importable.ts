import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TranscriptItem } from "@switchyard/protocol";
import { messagesToItems } from "./transcript.js";

/** A session is importable when its file has not changed for this long. */
export const INACTIVE_AFTER_MS = 120_000;

export interface ImportableSession {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  name: string | null;
  /** ISO time of the file's last modification. */
  mtime: string;
  /** True when the file is older than 120 s (no live Pi is likely writing it). */
  inactive: boolean;
  /** ISO creation time from the session header. */
  createdAt: string | null;
  parentSession: string | null;
}

/** Default Pi sessions root: `$PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions`. */
export function defaultSessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

async function readFirstLine(file: string): Promise<string | null> {
  const fh = await open(file, "r");
  try {
    let collected = "";
    const buf = Buffer.alloc(16384);
    let position = 0;
    while (collected.length < 1_000_000) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      collected += buf.subarray(0, bytesRead).toString("utf8");
      const nl = collected.indexOf("\n");
      if (nl >= 0) return collected.slice(0, nl).replace(/\r$/, "");
    }
    return collected.length > 0 ? collected : null;
  } finally {
    await fh.close();
  }
}

/** Bytes read from the end of a session file before falling back to the whole file. */
const NAME_TAIL_BYTES = 64 * 1024;
const NAME_CACHE_MAX = 5000;
const nameCache = new Map<string, { mtimeMs: number; size: number; name: string | null }>();

/** The last `session_info` entry in a session file's text: whether there is one, and its name. */
function findSessionInfo(content: string): { found: boolean; name: string | null } {
  let found = false;
  let name: string | null = null;
  for (const line of content.split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const entry = JSON.parse(line.replace(/\r$/, ""));
      if (entry?.type === "session_info") {
        found = true;
        name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : null;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return { found, name };
}

/** The last `session_info` name in a session file's text, or null. */
export function lastSessionName(content: string): string | null {
  return findSessionInfo(content).name;
}

/**
 * Decode a file's tail. When `partial` (the file is longer than the tail), the first, cut line
 * is dropped, including any split multibyte character.
 */
function tailText(buf: Buffer, partial: boolean): string {
  const text = buf.toString("utf8");
  if (!partial) return text;
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : "";
}

function cached(file: string, st: Stats): string | null | undefined {
  const hit = nameCache.get(file);
  return hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit.name : undefined;
}

function remember(file: string, st: Stats, name: string | null): void {
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
  nameCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, name });
}

/**
 * Read the current display name of a session file (sync; used before resuming): from its last
 * 64 KB when a `session_info` entry is there, else from the whole file; cached by mtime and size.
 */
export function readSessionNameSync(file: string): string | null {
  try {
    const st = statSync(file);
    const hit = cached(file, st);
    if (hit !== undefined) return hit;
    const len = Math.min(st.size, NAME_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, buf, 0, len, st.size - len);
    } finally {
      closeSync(fd);
    }
    const partial = st.size > len;
    const tail = findSessionInfo(tailText(buf.subarray(0, bytesRead), partial));
    const name = tail.found
      ? tail.name
      : partial
        ? lastSessionName(readFileSync(file, "utf8"))
        : null;
    remember(file, st, name);
    return name;
  } catch {
    return null;
  }
}

/** Async `readSessionNameSync` for a file already stat'ed. */
async function readSessionName(file: string, st: Stats): Promise<string | null> {
  const hit = cached(file, st);
  if (hit !== undefined) return hit;
  const len = Math.min(st.size, NAME_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fh = await open(file, "r");
  let bytesRead: number;
  try {
    ({ bytesRead } = await fh.read(buf, 0, len, st.size - len));
  } finally {
    await fh.close();
  }
  const partial = st.size > len;
  const tail = findSessionInfo(tailText(buf.subarray(0, bytesRead), partial));
  const name = tail.found
    ? tail.name
    : partial
      ? lastSessionName(await readFile(file, "utf8"))
      : null;
  remember(file, st, name);
  return name;
}

async function findJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) await findJsonl(full, depth - 1, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/** List Pi session files under `sessionsRoot` with their header data, newest first. */
export async function listImportable(
  sessionsRoot: string = defaultSessionsRoot(),
  now: number = Date.now(),
): Promise<ImportableSession[]> {
  const files: string[] = [];
  await findJsonl(sessionsRoot, 2, files);
  const result: ImportableSession[] = [];
  for (const file of files) {
    try {
      const st = await stat(file);
      const first = await readFirstLine(file);
      if (!first) continue;
      const header = JSON.parse(first);
      if (header?.type !== "session" || typeof header.id !== "string") continue;
      result.push({
        sessionFile: file,
        sessionId: header.id,
        cwd: typeof header.cwd === "string" ? header.cwd : "",
        name: await readSessionName(file, st),
        mtime: st.mtime.toISOString(),
        inactive: now - st.mtimeMs > INACTIVE_AFTER_MS,
        createdAt: typeof header.timestamp === "string" ? header.timestamp : null,
        parentSession: typeof header.parentSession === "string" ? header.parentSession : null,
      });
    } catch {
      // unreadable or malformed file: not importable
    }
  }
  result.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return result;
}

// ---- Pi package resolution (for parseSessionEntries) ----

function findOnPath(bin: string): string | null {
  if (bin.includes("/")) return resolve(bin);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Locate the installed `@earendil-works/pi-coding-agent` package root from the Pi binary,
 * following symlinks and simple `exec "<path>"` wrapper scripts (e.g. Homebrew).
 */
export function resolvePiPackageRoot(piBin = "pi"): string | null {
  const onPath = findOnPath(piBin);
  if (!onPath) return null;
  const candidates: string[] = [];
  try {
    const real = realpathSync(onPath);
    candidates.push(real);
    const head = readFileSync(real, "utf8").slice(0, 4096);
    if (head.startsWith("#!") && !/node/.test(head.split("\n")[0] ?? "")) {
      for (const m of head.matchAll(/exec\s+"([^"]+)"/g)) {
        try {
          candidates.push(realpathSync(m[1]!));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return null;
  }
  for (const start of candidates) {
    let dir = dirname(start);
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg?.name === "@earendil-works/pi-coding-agent") return dir;
      } catch {
        // continue
      }
      const nested = join(dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
      try {
        const pkg = JSON.parse(readFileSync(join(nested, "package.json"), "utf8"));
        if (pkg?.name === "@earendil-works/pi-coding-agent") return nested;
      } catch {
        // continue
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

type EntryParser = (content: string) => any[];
let parserPromise: Promise<EntryParser | null> | null = null;

/** Load `parseSessionEntries` from the installed Pi, or null if unavailable. */
export function loadPiEntryParser(piBin = "pi"): Promise<EntryParser | null> {
  parserPromise ??= (async () => {
    const root = resolvePiPackageRoot(piBin);
    if (!root) return null;
    try {
      const mod: any = await import(pathToFileURL(join(root, "dist", "index.js")).href);
      return typeof mod.parseSessionEntries === "function" ? mod.parseSessionEntries : null;
    } catch {
      return null;
    }
  })();
  return parserPromise;
}

/** Minimal fallback parser: one JSON entry per LF line, malformed lines skipped. */
export function parseEntriesFallback(content: string): any[] {
  const entries: any[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return entries;
}

/** Entries on the active branch (leaf = last entry with an id), root first. */
export function activeBranch(entries: any[]): any[] {
  const byId = new Map<string, any>();
  let leaf: any = null;
  for (const e of entries) {
    if (e && typeof e.id === "string" && e.type !== "session") {
      byId.set(e.id, e);
      leaf = e;
    }
  }
  const branch: any[] = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    branch.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : null;
  }
  return branch.reverse();
}

/** Session entries to AgentMessage-like records for `messagesToItems`. */
export function entriesToMessages(entries: any[]): any[] {
  const messages: any[] = [];
  for (const e of entries) {
    const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
    switch (e.type) {
      case "message":
        if (e.message) messages.push({ timestamp: ts, ...e.message });
        break;
      case "custom_message":
        messages.push({
          role: "custom",
          customType: e.customType,
          content: e.content,
          display: e.display,
          timestamp: ts,
        });
        break;
      case "compaction":
        messages.push({ role: "compactionSummary", summary: e.summary, timestamp: ts });
        break;
      case "branch_summary":
        messages.push({ role: "branchSummary", summary: e.summary, timestamp: ts });
        break;
      default:
        break;
    }
  }
  return messages;
}

export interface ReadNativeOptions {
  /** Switchyard session id for the produced items (default: the native session id). */
  sessionId?: string;
  startOrder?: number;
  newItemId?: () => string;
  piBin?: string;
  /** Try Pi's own `parseSessionEntries` first (default true). */
  usePiParser?: boolean;
}

/** Read a Pi session file into transcript items (active branch), for read-only views and import. */
export async function readNativeTranscript(
  file: string,
  opts: ReadNativeOptions = {},
): Promise<{ sessionId: string; cwd: string; name: string | null; items: TranscriptItem[] }> {
  const content = await readFile(file, "utf8");
  let entries: any[] | null = null;
  if (opts.usePiParser !== false) {
    const parser = await loadPiEntryParser(opts.piBin);
    if (parser) {
      try {
        entries = parser(content);
      } catch {
        entries = null;
      }
    }
  }
  entries ??= parseEntriesFallback(content);
  const header = entries.find((e) => e?.type === "session") ?? {};
  const nativeId = typeof header.id === "string" ? header.id : "";
  const items = messagesToItems(entriesToMessages(activeBranch(entries)), {
    sessionId: opts.sessionId ?? nativeId,
    startOrder: opts.startOrder,
    newItemId: opts.newItemId,
    fallbackAt: typeof header.timestamp === "string" ? header.timestamp : undefined,
  });
  return {
    sessionId: nativeId,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name: lastSessionName(content),
    items,
  };
}
