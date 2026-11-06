import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { listRecentSessionCwds } from "@switchyard/pi-runtime";
import type { ProjectSuggestions } from "@switchyard/protocol";
import { mapLimit } from "./concurrency.js";
import { runGit } from "./git.js";

const MAX_SUGGESTIONS = 20;

/** Map a session cwd to its repository's main checkout root, or null when it is not one. */
async function repoRoot(cwd: string, home: string): Promise<string | null> {
  if (cwd === "" || cwd === "/" || cwd === home || !existsSync(cwd)) return null;
  const r = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    allowFail: true,
  });
  const common = r.stdout.trim();
  if (r.code !== 0 || !common.endsWith("/.git")) return null;
  const root = await realpath(dirname(common)).catch(() => null);
  return root && root !== home ? root : null;
}

/** Repositories used with Pi recently, most used first (worktrees count toward their repository). */
export async function suggestProjects(
  sessionsRoot: string,
  opts: { days: number; now?: number; home?: string },
): Promise<ProjectSuggestions> {
  const home = opts.home ?? homedir();
  const since = (opts.now ?? Date.now()) - opts.days * 86_400_000;
  const sessions = await listRecentSessionCwds(sessionsRoot, since);
  const cwds = [...new Set(sessions.map((s) => s.cwd))];
  const roots = new Map<string, string | null>();
  await mapLimit(cwds, 8, async (cwd) => {
    roots.set(cwd, await repoRoot(cwd, home));
  });
  const agg = new Map<string, { sessionCount: number; lastActivityAt: string }>();
  for (const s of sessions) {
    const root = roots.get(s.cwd);
    if (!root) continue;
    const a = agg.get(root) ?? { sessionCount: 0, lastActivityAt: "" };
    a.sessionCount += 1;
    if (s.mtime > a.lastActivityAt) a.lastActivityAt = s.mtime;
    agg.set(root, a);
  }
  const suggestions = [...agg.entries()]
    .map(([rootPath, a]) => ({ rootPath, ...a }))
    .sort(
      (a, b) => b.sessionCount - a.sessionCount || b.lastActivityAt.localeCompare(a.lastActivityAt),
    )
    .slice(0, MAX_SUGGESTIONS);
  return { suggestions };
}
