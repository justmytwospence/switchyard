import { isProjectFolderPath, type ProjectScan } from "@switchyard/protocol";
import { formatRelative } from "../../lib/time";
import { splitLines } from "./shared";

export const MAX_PROJECT_FOLDERS = 20;

/** One folder per line; the first problem found, if any. */
export function parseProjectFolders(text: string): { folders: string[]; problem: string | null } {
  const folders = splitLines(text);
  const bad = folders.find((f) => !isProjectFolderPath(f));
  if (bad) return { folders, problem: `"${bad}" is not an absolute path or a ~/ path.` };
  if (folders.length > MAX_PROJECT_FOLDERS) {
    return { folders, problem: `Use at most ${MAX_PROJECT_FOLDERS} folders.` };
  }
  return { folders, problem: null };
}

/** A sentence describing the host's last project folder scan. */
export function scanSummary(scan: ProjectScan | null | undefined, now = Date.now()): string {
  if (!scan) return "Not scanned yet.";
  if (scan.state === "running") return "Scanning…";
  if (scan.state === "failed") {
    return `Last scan failed ${formatRelative(scan.finishedAt ?? scan.startedAt, now)}: ${scan.errors.at(-1) ?? "unknown error"}`;
  }
  return `Last scanned ${formatRelative(scan.finishedAt, now)}: ${scan.repositories} repositories, ${scan.checkoutsAdded} new checkouts, ${scan.projectsCreated} new projects.`;
}
