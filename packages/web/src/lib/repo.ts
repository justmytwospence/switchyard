import type { Project } from "@switchyard/protocol";

/** "Local only" for repositories without a remote (`local:<sha|path>`), else the remote without its scheme. */
export function repoLabel(identity: string): string {
  if (identity.startsWith("local:")) return "Local only";
  return identity.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

/** Case-insensitive match on project name or remote. */
export function matchesProject(p: Pick<Project, "name" | "repoIdentity">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || p.repoIdentity.toLowerCase().includes(q);
}
