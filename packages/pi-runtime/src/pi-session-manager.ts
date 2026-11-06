import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SwitchyardError, type TreeRow } from "@switchyard/protocol";
import { resolvePiPackageRoot } from "./importable.js";

let managerPromise: Promise<any | null> | null = null;

/** Load Pi's `SessionManager` from the installed Pi, or null if unavailable. */
export function loadPiSessionManager(piBin = "pi"): Promise<any | null> {
  managerPromise ??= (async () => {
    const root = resolvePiPackageRoot(piBin);
    if (!root) return null;
    try {
      const mod: any = await import(pathToFileURL(join(root, "dist", "index.js")).href);
      return mod.SessionManager ?? null;
    } catch {
      return null;
    }
  })();
  return managerPromise;
}

function messageText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join(" ");
}

const MAX_ROWS = 2000;

/** The conversation tree as rows of user and assistant messages. */
export function treeRows(sm: any, liveLeaf: string | null = null): TreeRow[] {
  // The running Pi's leaf can be ahead of the file's (a rewind only moves it in memory).
  if (liveLeaf && sm.getEntry?.(liveLeaf)) sm.branch?.(liveLeaf);
  const active = new Set<string>((sm.getBranch() ?? []).map((e: any) => e.id));
  const leafId: string | null = sm.getLeafId?.() ?? null;
  const rows: TreeRow[] = [];
  const walk = (nodes: any[], depth: number, parentId: string | null): void => {
    for (const node of nodes) {
      if (rows.length >= MAX_ROWS) return;
      const entry = node.entry;
      const role = entry?.message?.role;
      const shown = entry?.type === "message" && (role === "user" || role === "assistant");
      if (shown) {
        const raw = messageText(entry.message).replace(/\s+/g, " ").trim();
        const text = raw ? raw.slice(0, 160) : role === "assistant" ? "(tool calls)" : "";
        rows.push({
          entryId: entry.id,
          parentId,
          depth,
          role,
          text,
          activeBranch: active.has(entry.id),
          leaf: entry.id === leafId,
          label: node.label ?? null,
          at: typeof entry.timestamp === "string" ? entry.timestamp : null,
        });
        walk(node.children ?? [], depth + 1, entry.id);
      } else {
        walk(node.children ?? [], depth, parentId);
      }
    }
  };
  walk(sm.getTree() ?? [], 0, null);
  if (!rows.some((r) => r.leaf)) {
    const last = [...rows].reverse().find((r) => r.activeBranch);
    if (last) last.leaf = true;
  }
  return rows;
}

/** Write a branched session file with Pi's own SessionManager. */
export async function branchSession(
  sessionFile: string,
  entryId: string | null,
  fork: boolean,
  piBin?: string,
  load: (piBin?: string) => Promise<any | null> = loadPiSessionManager,
  checkFile = true,
  liveLeaf: string | null = null,
): Promise<{ sessionFile: string | null; prefill: string | null }> {
  const SM = await load(piBin);
  if (!SM) {
    throw new SwitchyardError(
      "invalid_request",
      "Pi's SessionManager could not be loaded on this host",
    );
  }
  const sm = SM.open(sessionFile, dirname(sessionFile));
  let target: string | null;
  let prefill: string | null = null;
  if (fork) {
    const e = entryId ? sm.getEntry(entryId) : undefined;
    if (!e || e.type !== "message" || e.message?.role !== "user") {
      throw new SwitchyardError("invalid_request", "Pick one of your messages to fork from");
    }
    prefill = messageText(e.message);
    target = e.parentId ?? null;
    if (!target) return { sessionFile: null, prefill };
  } else {
    target = entryId ?? liveLeaf ?? sm.getLeafId();
    if (!target) {
      throw new SwitchyardError("invalid_request", "This session has nothing to branch yet");
    }
  }
  // Pi writes a branch file only once it holds a message; a branch of setup entries alone is empty.
  const hasMessages = (sm.getBranch(target) ?? []).some(
    (e: any) =>
      e?.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
  );
  if (!hasMessages) {
    if (fork) return { sessionFile: null, prefill };
    throw new SwitchyardError("invalid_request", "There is no conversation before that point");
  }
  const file = sm.createBranchedSession(target);
  if (!file || (checkFile && !existsSync(file))) {
    throw new SwitchyardError("invalid_request", "Pi did not write a branched session");
  }
  return { sessionFile: file, prefill };
}
