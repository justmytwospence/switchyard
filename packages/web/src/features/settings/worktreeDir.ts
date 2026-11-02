import { WorktreeDir } from "@switchyard/protocol";

export const DEFAULT_WORKTREE_DIR = ".worktrees";
export const WORKTREE_DIR_HINT =
  "Inside the repository, for example .worktrees or .git/worktrees-switchyard";

/** Client-side check of a worktree folder (the coordinator and host validate again). */
export function worktreeDirProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter a folder inside the repository, e.g. .worktrees.";
  if (v.startsWith("/") || /^[A-Za-z]:/.test(v) || v.includes("\\")) {
    return "Use a relative path inside the repository, e.g. .worktrees.";
  }
  if (v.split("/").includes("..")) return "The folder must stay inside the repository (no ..).";
  if (!WorktreeDir.safeParse(v).success) {
    return "Use a plain relative path such as .worktrees (no empty or . segments).";
  }
  return null;
}
