import type { GitCommit, LogResult } from "@switchyard/protocol";
import { formatRelative } from "../../lib/time";

/** What the Changes tab shows: everything against the base, only uncommitted work, or one commit (full SHA). */
export type DiffScope = "all" | "uncommitted" | (string & {});

/** The `rev` for a scope; none for everything. */
export function scopeRev(scope: DiffScope): string | undefined {
  return scope === "all" ? undefined : scope;
}

export function commitsHeading(log: LogResult): string {
  if (log.scope === "recent") return "Recent commits";
  return `Commits on this branch (${log.commits.length}${log.truncated ? "+" : ""})`;
}

export function commitMeta(c: GitCommit, now = Date.now()): string {
  const parts = [c.sha.slice(0, 7), c.author, formatRelative(c.authoredAt, now)];
  if (!c.pushed) parts.push("not pushed");
  return parts.join(" · ");
}

export function scopeLabel(scope: DiffScope, base: string | null): string {
  if (scope === "all") return base ? `Against ${base}` : "";
  if (scope === "uncommitted") return "Uncommitted changes";
  return `Commit ${scope.slice(0, 7)}`;
}

export function emptyScopeText(
  scope: DiffScope,
  base: string,
): { title: string; description: string } {
  if (scope === "all")
    return {
      title: "No changes yet",
      description: `Nothing differs from ${base} in this workspace.`,
    };
  if (scope === "uncommitted")
    return {
      title: "Nothing uncommitted",
      description: "Every change in this workspace is committed.",
    };
  return {
    title: "No file changes",
    description: "This commit changes no files against its first parent.",
  };
}
