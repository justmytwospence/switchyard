import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type ProjectFolderScan,
  type ScannedRepository,
  SwitchyardError,
} from "@switchyard/protocol";
import { mapLimit } from "./concurrency.js";
import { inspectCheckout } from "./git.js";

/** `~` and `~/rest` relative to `home`; anything else unchanged. */
export function expandHome(folder: string, home = homedir()): string {
  if (folder === "~") return home;
  if (folder.startsWith("~/")) return join(home, folder.slice(2));
  return folder;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The git repositories directly inside `folder` (depth 1): non-hidden directories (or symlinks to
 * them) that are the main checkout of their repository. Linked worktrees, submodules and plain
 * directories are skipped.
 */
export async function scanProjectFolder(
  folder: string,
  opts: { home?: string; concurrency?: number } = {},
): Promise<ProjectFolderScan> {
  const p = expandHome(folder.trim(), opts.home);
  if (!isAbsolute(p)) {
    throw new SwitchyardError(
      "invalid_request",
      "Project folders must be absolute or start with ~/",
    );
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(p);
  } catch {
    throw new SwitchyardError("not_found", `${folder} does not exist on this host`);
  }
  if (!st.isDirectory()) {
    throw new SwitchyardError("invalid_request", `${folder} is not a directory`);
  }
  const root = await realpath(p);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory() || (e.isSymbolicLink() && (await isDirectory(join(root, e.name))))) {
      candidates.push(e.name);
    }
  }
  const found = await mapLimit(
    candidates,
    opts.concurrency ?? 8,
    async (name): Promise<ScannedRepository | null> => {
      const dir = join(root, name);
      try {
        await lstat(join(dir, ".git"));
      } catch {
        return null;
      }
      const info = await inspectCheckout(dir).catch(() => null);
      if (!info) return null;
      if (info.root !== (await realpath(dir).catch(() => ""))) return null;
      const ownGitDir = await realpath(join(info.root, ".git")).catch(() => "");
      if (info.commonDir !== ownGitDir) return null;
      return { ...info, name };
    },
  );
  const repositories = found
    .filter((r): r is ScannedRepository => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { folder: root, repositories };
}
