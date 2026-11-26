import type { Scope, ScopeInput, ScopePatch } from "@switchyard/protocol";
import {
  bodyOf,
  draftOf,
  type GitHubSourceDraft,
  type GitHubSourceDraftErrors,
  validateDraft,
} from "./githubSourceLogic";

/** What a scope contains: the one choice that decides its mode and whether GitHub feeds it. */
export type ScopeContents = "projects" | "pins" | "github";

export interface ScopeDraft {
  name: string;
  contents: ScopeContents;
  /** Checked projects; empty: any. Shown under "projects"; sent under "pins" too, so the choice survives a round trip. */
  projectIds: string[];
  /** Checked hosts; empty: any. */
  hostIds: string[];
  github: GitHubSourceDraft;
}
export type ScopeDraftErrors = GitHubSourceDraftErrors;

export const CONTENTS_OPTIONS: { value: ScopeContents; label: string; explanation: string }[] = [
  {
    value: "projects",
    label: "Projects you choose",
    explanation: "Sessions in the projects you check, plus any session you pin.",
  },
  { value: "pins", label: "Pins only", explanation: "Only the sessions you pin to it." },
  {
    value: "github",
    label: "GitHub issues",
    explanation: "Issues assigned to you or on a Projects board, and the sessions working on them.",
  },
];

export function contentsOf(scope: Scope | null): ScopeContents {
  if (scope?.source) return "github";
  return scope?.mode === "pinned" ? "pins" : "projects";
}

export function scopeDraftOf(scope: Scope | null, defaultHostId: string): ScopeDraft {
  return {
    name: scope?.name ?? "",
    contents: contentsOf(scope),
    projectIds: scope?.projectIds ?? [],
    hostIds: scope?.hostIds ?? [],
    github: draftOf(scope, defaultHostId),
  };
}

export function validateScopeDraft(d: ScopeDraft): ScopeDraftErrors {
  const all = validateDraft({ ...d.github, name: d.name });
  if (d.contents === "github") return all;
  return all.name ? { name: all.name } : {};
}

/** The body for POST (new) or PATCH (`scope` given) /api/scopes. */
export function scopeBodyOf(d: ScopeDraft, scope: Scope | null): ScopeInput & ScopePatch {
  const name = d.name.trim();
  const hostIds = d.hostIds.length ? d.hostIds : null;
  if (d.contents === "github") {
    // GitHub keeps the projects of a GitHub scope: sending projectIds would be refused.
    return { name, mode: "all", hostIds, source: bodyOf({ ...d.github, name }).source };
  }
  return {
    name,
    mode: d.contents === "pins" ? "pinned" : "all",
    projectIds: d.projectIds.length ? d.projectIds : null,
    hostIds,
    ...(scope?.source ? { source: null } : {}),
  };
}

/** True when saving removes a GitHub source the scope has now. */
export function disconnects(d: ScopeDraft, scope: Scope | null): boolean {
  return !!scope?.source && d.contents !== "github";
}
