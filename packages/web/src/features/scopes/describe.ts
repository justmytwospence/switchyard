import {
  type Client,
  type GitHubSource,
  type Host,
  openClients,
  type Project,
  type Scope,
  type SyncedIssue,
  sourceBacklog,
  sourceFollow,
} from "@switchyard/protocol";
import { githubRepository, type InventoryIntent } from "../discovery/model";

/** What decides a scope's members: a GitHub source, or the scope's own filters and pins. */
export type ScopeSourceKind = "github" | "manual";

export function scopeSourceKind(v: Scope): ScopeSourceKind {
  return v.source ? "github" : "manual";
}

/** The option text in scope selectors: the name, marked when GitHub feeds it. */
export function scopeOptionLabel(v: Scope): string {
  return v.source ? `${v.name} · GitHub` : v.name;
}

function names(ids: string[], byId: Record<string, { name: string }>): string {
  const known = ids.map((id) => byId[id]?.name).filter((n): n is string => !!n);
  if (known.length <= 3) return known.join(", ");
  return `${known.slice(0, 3).join(", ")} and ${known.length - 3} more`;
}

export interface DescribeContext {
  projects: Record<string, Pick<Project, "name">>;
  hosts: Record<string, Pick<Host, "name">>;
}

export interface DiscoverySourceDetails {
  id: string;
  name: string;
  description: string;
  paused: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface DiscoveryEmptyState {
  title: string;
  description: string;
  action?: { label: string; to: string };
}

export interface DiscoverySourceDescription {
  summary: string;
  sources: DiscoverySourceDetails[];
  openIssuesUrl: string | null;
  emptyState: (filtered: boolean) => DiscoveryEmptyState;
}

function describeIssueSource(scope: Scope): DiscoverySourceDetails[] {
  const source = scope.source;
  if (!source) return [];
  const details: string[] = [];
  if (sourceFollow(source) === "assigned") details.push(`Assigned to ${source.login ?? "you"}`);
  if (source.board) details.push(`Board #${source.board.projectNumber}`);
  const backlog = sourceBacklog(source);
  if (backlog.length) details.push(`excludes ${backlog.join(", ")} until work starts`);
  if (!source.enabled) details.push("Sync paused");
  return [
    {
      id: scope.id,
      name: scope.name,
      description: details.join(" · "),
      paused: !source.enabled,
      lastSyncedAt: source.lastSyncedAt,
      lastError: source.lastError,
    },
  ];
}

function coversProject(scope: Scope | null, projectId: string): boolean {
  return !scope || scope.projectIds === null || scope.projectIds.includes(projectId);
}

/** Where the tracked issue menu gets its rows. A manual scope can consume any covering source. */
export function describeDiscoverySource(
  scope: Scope | null,
  project: Pick<Project, "id" | "repoIdentity"> | null,
  scopes: Record<string, Scope> | readonly Scope[],
): DiscoverySourceDescription {
  const pinsOnly = scope?.mode === "pinned";
  const includesProject = !project || coversProject(scope, project.id);
  const sources = (
    pinsOnly || !includesProject
      ? []
      : scope?.source
        ? [scope]
        : Object.values<Scope>(scopes).filter((candidate) => {
            if (!candidate.source || candidate.mode === "pinned") return false;
            if (project) return coversProject(candidate, project.id);
            const ids = candidate.projectIds;
            const selected = scope?.projectIds ?? null;
            if (selected === null) return true;
            return ids === null ? selected.length > 0 : selected.some((id) => ids.includes(id));
          })
  )
    .flatMap(describeIssueSource)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const repository = project && githubRepository(project);
  const openIssuesUrl =
    !pinsOnly && includesProject && repository ? `https://github.com/${repository}/issues` : null;
  return {
    summary: sources.length
      ? `Tracked by ${sources.map((source) => source.name).join(", ")}`
      : pinsOnly
        ? "This scope contains pinned sessions only"
        : "No issue source connected",
    sources,
    openIssuesUrl,
    emptyState: (filtered) => {
      if (pinsOnly)
        return {
          title: "This scope contains pinned sessions only",
          description: "Pinned sessions are shown in the branch overview, not in tracked issues.",
        };
      if (!sources.length)
        return {
          title: "No issue source connected",
          description: "Connect an issue source that covers this work in Settings → Scopes.",
          action: { label: "Settings → Scopes", to: "/settings/scopes" },
        };
      if (sources.some((s) => s.paused || s.lastError || !s.lastSyncedAt)) {
        return {
          title: "No current issue results",
          description:
            "At least one source is stale or unavailable. Its last sync does not establish an empty list.",
        };
      }
      return filtered
        ? { title: "No matches", description: "Clear the search or change the issue filters." }
        : {
            title: "No tracked issues here",
            description: "Only issues followed by the listed sources are shown here.",
          };
    },
  };
}

export function sourceNeedsRefresh(
  source: Pick<GitHubSource, "enabled" | "lastError" | "lastSyncedAt">,
) {
  return !source.enabled || !!source.lastError || !source.lastSyncedAt;
}

export const KNOWN_WORK_COVERAGE =
  "Tracked work across repositories · choose a repository to browse its open issues.";

export function describeInventory(
  intent: InventoryIntent<Pick<Project, "id" | "name" | "repoIdentity">>,
  scope: Scope | null,
  scopes: Record<string, Scope>,
): DiscoverySourceDescription {
  if (intent.kind === "repository" && !intent.repository) {
    return {
      summary: "Repository issues unavailable",
      sources: [],
      openIssuesUrl: null,
      emptyState: () => ({
        title: "No GitHub repository for this project",
        description: "Choose a project with a GitHub repository to browse its issues.",
      }),
    };
  }
  if (intent.kind === "repository") {
    return {
      summary: `Open issues in ${intent.repository}`,
      sources: [],
      openIssuesUrl: `https://github.com/${intent.repository}/issues`,
      emptyState: (filtered) =>
        filtered
          ? { title: "No matches", description: "Clear the search or change the issue filters." }
          : {
              title: "No open issues",
              description: "There are no open issues in this repository.",
            },
    };
  }
  const tracked = describeDiscoverySource(scope, intent.project, scopes);
  if (intent.coverage !== "known" || intent.project) return tracked;
  return { ...tracked, summary: KNOWN_WORK_COVERAGE };
}

/** The configured move this issue could qualify for on a later sync, not a promised update. */
export function discoveryWriteBackHint(
  issue: SyncedIssue,
  scope: Scope | undefined,
): string | null {
  const source = scope?.source;
  const board = issue.board;
  if (!source?.enabled || !source.writeBack || !source.board || !board) return null;
  if (issue.pullRequest?.state === "MERGED") return null;
  const login = source.login?.toLowerCase();
  const mine = login && issue.assignees.some((a) => a.toLowerCase() === login);
  if (!mine && !(sourceFollow(source) === "board" && issue.assignees.length === 0)) return null;
  if (issue.assignees.length > 1 && !source.moveShared) return null;
  const target =
    issue.pullRequest?.state === "OPEN" && source.board.onReview
      ? source.board.onReview
      : source.board.onStart;
  if (!target) return null;
  const column = board.options.find((option) => option.name.toLowerCase() === target.toLowerCase());
  if (
    !column ||
    board.statusOptionId === column.id ||
    board.status?.toLowerCase() === target.toLowerCase()
  )
    return null;
  return `On sync, may move to ${column.name}`;
}

/** One line saying where a scope's sessions (or, on the Tasks page, tasks) come from. */
export function describeScope(
  v: Scope,
  ctx: DescribeContext,
  subject: "sessions" | "tasks" = "sessions",
): string {
  const t = v.source;
  const x = t?.extraRepositories ?? [];
  const also =
    x.length === 1 ? ` and ${x[0]}` : x.length > 1 ? ` and ${x.length} other repositories` : "";
  if (subject === "tasks") {
    if (t) return `Tasks in the repositories of ${t.owner}${also}`;
    if (v.mode === "pinned") return "Tasks of sessions you pin";
    const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
    return projectNames ? `Tasks in ${projectNames}` : "Every task";
  }
  if (t) {
    // A paused source has stopped following issues: say so where its scope looks empty.
    const paused = t.enabled === false ? " (sync paused: issues are not updated)" : "";
    if (t.board && sourceFollow(t) === "board") {
      const backlog = sourceBacklog(t);
      return `Issues on ${t.owner}'s board #${t.board.projectNumber}${backlog.length ? `, except ${backlog.join(", ")}` : ""}, and live sessions there${paused}`;
    }
    const board = t.board ? ` (board #${t.board.projectNumber})` : "";
    return `Issues assigned to ${t.login ?? "you"} in ${t.owner}${also}${board}, and live sessions there${paused}`;
  }
  if (v.mode === "pinned") return "Only sessions you pin";
  const projectNames = v.projectIds ? names(v.projectIds, ctx.projects) : "";
  const hostNames = v.hostIds ? names(v.hostIds, ctx.hosts) : "";
  if (!projectNames && !hostNames) return "Every session";
  if (!projectNames) return `Sessions on ${hostNames}`;
  return `Sessions in ${projectNames}${hostNames ? ` on ${hostNames}` : ""}`;
}

/** Clients mirroring this scope now, as "herdr vo on mac-pro, tmux main on nuc"; null when none. */
export function shownIn(
  v: Scope,
  clients: Client[],
  hosts: Record<string, Pick<Host, "name">> = {},
  now = Date.now(),
): string | null {
  const open = openClients(clients, v.id, now);
  if (open.length === 0) return null;
  return open
    .map((c) => `${c.kind} ${c.name} on ${(c.hostId && hosts[c.hostId]?.name) || c.machine}`)
    .join(", ");
}

/** What a client mirrors, for a list: "everything", "scope work" or "nothing". */
export function mirrorLabel(
  t: Pick<Client, "mirror" | "scopeId">,
  scopes: Record<string, Pick<Scope, "name">>,
): string {
  if (t.mirror === "all") return "everything";
  if (t.mirror === "scope") return `scope ${(t.scopeId && scopes[t.scopeId]?.name) || "(deleted)"}`;
  return "nothing";
}

export type ScopeEmptyFilter = "active" | "attention" | "all";

/**
 * Title and explanation for a selected scope with nothing to list. `source` is describeScope's
 * text (what the scope contains); `origin` is this deployment's host name.
 */
export function emptyScopeState(
  v: Scope,
  opts: { filter: ScopeEmptyFilter; source: string; origin: string },
): { title: string; description: string } {
  const title =
    opts.filter === "attention"
      ? `Nothing needs your input in ${v.name}`
      : opts.filter === "active"
        ? `No active sessions in ${v.name}`
        : `No sessions in ${v.name}`;
  const source = scopeSourceKind(v);
  let description: string;
  if (source === "github") {
    description = `This scope shows sessions on ${v.name}'s issues and live sessions in its repositories. Issues that are not started are on the Board.`;
  } else if (source === "manual" && v.mode === "pinned") {
    description = `This scope holds only sessions you pin. Pin one from its menu: Pin to ${v.name}.`;
  } else {
    description = `This scope contains: ${opts.source}.`;
  }
  return { title, description };
}
