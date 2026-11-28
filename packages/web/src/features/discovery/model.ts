import {
  type Branch,
  type BranchPlacement,
  type BranchStage,
  buildBranches,
  GitHubRepository,
  issueInScope,
  issueUnstarted,
  type Project,
  type RepoIssueItem,
  type Scope,
  type Session,
  type SyncedIssue,
  type TrackedIssue,
  type Workspace,
} from "@switchyard/protocol";

export interface DiscoveryContext {
  coverage: "all" | "projects" | "pins";
  /** Null is unrestricted. Keep declared IDs even when the project record is not synced yet. */
  projectIds: string[] | null;
  fixedProjectId: string | null;
}

/** The scope sets coverage. Neither current issue results nor local/online checkouts set it. */
export function discoveryContext(
  scope: Scope | null,
  projects: readonly Pick<Project, "id">[],
): DiscoveryContext {
  if (scope?.mode === "pinned") return { coverage: "pins", projectIds: [], fixedProjectId: null };
  if (!scope || scope.projectIds === null)
    return { coverage: "all", projectIds: null, fixedProjectId: null };
  const projectIds = [...new Set(scope.projectIds)];
  const fixedProjectId =
    projectIds.length === 1 && projects.some((p) => p.id === projectIds[0]) ? projectIds[0]! : null;
  return { coverage: "projects", projectIds, fixedProjectId };
}

/** Resolved choices for a local refinement, not a second scope. */
export function discoveryProjects<T extends Pick<Project, "id" | "name">>(
  scope: Scope | null,
  projects: readonly T[],
): T[] {
  const { projectIds } = discoveryContext(scope, projects);
  const covered = projectIds === null ? null : new Set(projectIds);
  return projects
    .filter((p) => !covered || covered.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function githubRepository(project: Pick<Project, "repoIdentity">): string | null {
  const prefix = "https://github.com/";
  const identity = project.repoIdentity;
  return identity?.startsWith(prefix)
    ? (GitHubRepository.safeParse(identity.slice(prefix.length)).data ?? null)
    : null;
}

export type IssueEntry = { kind: "contextual" } | { kind: "repository"; projectId: string };
export type InventoryIntent<T> =
  | { kind: "repository"; coverage: "repository"; project: T; repository: string }
  | { kind: "repository"; coverage: "repository"; project: T | null; repository: null }
  | { kind: "tracked"; coverage: "source" | "known"; project: T | null }
  | { kind: "pins"; coverage: "pins"; project: null };

/** Pick the inventory before applying the query or the subset. No result set can widen coverage. */
export function inventoryIntent<T extends Pick<Project, "id" | "repoIdentity">>(
  scope: Scope | null,
  entry: IssueEntry,
  projectId: string | null,
  projects: Record<string, T>,
): InventoryIntent<T> {
  const { coverage, fixedProjectId, projectIds } = discoveryContext(scope, Object.values(projects));
  if (entry.kind === "contextual" && coverage === "pins")
    return { kind: "pins", coverage: "pins", project: null };
  const id = entry.kind === "repository" ? entry.projectId : (projectId ?? fixedProjectId);
  const project =
    id && (entry.kind === "repository" || projectIds === null || projectIds.includes(id))
      ? (projects[id] ?? null)
      : null;
  const repository = project && githubRepository(project);
  if (project && repository && (entry.kind === "repository" || !scope?.source))
    return { kind: "repository", coverage: "repository", project, repository };
  if (entry.kind === "repository")
    return { kind: "repository", coverage: "repository", project, repository: null };
  return { kind: "tracked", coverage: scope?.source ? "source" : "known", project };
}

/** Use beside the existing scope selector or on its own; never repeat the same name. */
export function scopeRepositoryLabel(
  scope: Pick<Scope, "name">,
  project: Pick<Project, "name">,
  scopeLabelVisible = false,
): string | null {
  if (scope.name.toLowerCase() === project.name.toLowerCase())
    return scopeLabelVisible ? null : scope.name;
  return scopeLabelVisible ? project.name : `${scope.name} · ${project.name}`;
}

/** Structural subset of the synced data; the Board's columns and runtime are not inputs. */
export interface DiscoveryInput {
  projects: Record<string, Pick<Project, "id" | "name">>;
  issues: Record<string, TrackedIssue>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, Session>;
  scopes?: Record<string, Pick<Scope, "name">>;
}

export interface IssueInventoryOptions {
  scope: Scope | null;
  projectId: string | null;
  query: string;
  subset: "notStarted" | "all";
  sort: "number" | "priority";
}

export type IssueLocator =
  | { kind: "tracked"; id: string }
  | { kind: "repository"; projectId: string; number: number; nodeId: string };

export function issueLocatorKey(locator: IssueLocator): string {
  return locator.kind === "tracked"
    ? locator.id
    : `repo:${JSON.stringify([locator.projectId, locator.nodeId])}`;
}

type IssueFacts = SyncedIssue & {
  projectId: string;
  branch: string | null;
  workspaceId: string | null;
};

export interface IssueInventoryItem<T extends IssueFacts = IssueFacts> {
  id: string;
  locator: IssueLocator;
  issue: T;
  sourceId: string | null;
  projectId: string;
  projectName: string;
  origin: string;
  showOrigin: boolean;
  branch: Branch | null;
  branchName: string | null;
  placement: BranchPlacement | null;
  sessionId: string | null;
  notStarted: boolean;
  merged: boolean;
  stage: BranchStage;
}

export function filterInventory(
  items: IssueInventoryItem[],
  text: string,
  subset: IssueInventoryOptions["subset"],
) {
  const query = text.trim().toLowerCase();
  if (!query && subset === "all") return items;
  return items.filter(
    (item) =>
      (subset === "all" || (item.notStarted && !item.merged)) &&
      matchesIssue(item.issue, item.projectName, query),
  );
}

function matchesIssue(issue: SyncedIssue, projectName: string, query: string): boolean {
  if (!query) return true;
  if (/^#?\d+$/.test(query) && Number(query.replace(/^#/, "")) === issue.number) return true;
  return [
    issue.title,
    `#${issue.number}`,
    issue.repository,
    projectName,
    issue.board?.status,
    issue.board?.priority?.name,
    ...issue.assignees,
  ].some((part) => part?.toLowerCase().includes(query));
}

const byNumber = (a: SyncedIssue, b: SyncedIssue) =>
  a.repository.localeCompare(b.repository) || a.number - b.number;
const rank = (i: SyncedIssue) => i.board?.priority?.rank ?? Number.MAX_SAFE_INTEGER;
const branchIdentity = (projectId: string, branch: string) => JSON.stringify([projectId, branch]);
export const issueIdentity = (issue: Pick<IssueFacts, "projectId" | "itemId">) =>
  JSON.stringify([issue.projectId, issue.itemId]);

/** Board memberships are deliberately not deduplicated. */
export function issueInventory(
  input: DiscoveryInput,
  options: IssueInventoryOptions,
  repositoryRows: readonly RepoIssueItem[] = [],
): IssueInventoryItem<TrackedIssue>[] {
  const { scope, projectId } = options;
  const covered = Object.values(input.issues).filter(
    (issue) =>
      (!scope || issueInScope(scope, issue)) && (!projectId || issue.projectId === projectId),
  );
  return projectIssues(input, options, covered, repositoryRows);
}

export function repositoryInventory(
  input: DiscoveryInput,
  options: IssueInventoryOptions,
  rows: readonly RepoIssueItem[],
): IssueInventoryItem[] {
  return projectIssues(input, options, [
    ...new Map(rows.map((row) => [issueIdentity(row), row])).values(),
  ]);
}

function isTracked(issue: TrackedIssue | RepoIssueItem): issue is TrackedIssue {
  return "scopeId" in issue;
}

function isRepository(issue: TrackedIssue | RepoIssueItem): issue is RepoIssueItem {
  return "sessionId" in issue;
}

function projectIssues<T extends TrackedIssue | RepoIssueItem>(
  input: DiscoveryInput,
  options: IssueInventoryOptions,
  covered: readonly T[],
  repositoryRows: readonly RepoIssueItem[] = [],
): IssueInventoryItem<T>[] {
  const { scope, subset, sort } = options;
  const query = options.query.trim().toLowerCase();
  if (!covered.length) return [];
  const canonical = new Map(repositoryRows.map((row) => [issueIdentity(row), row]));

  // A branch card decorates only one issue. Index branch facts separately so siblings keep their
  // primary and placement without inheriting that issue's pull request, board policy or source.
  const { branches } = buildBranches({
    workspaces: Object.values(input.workspaces),
    sessions: Object.values(input.sessions),
    issues: [],
  });
  const byWorkspace = new Map<string, { branch: Branch; placement: BranchPlacement }>();
  const byBranch = new Map<string, Branch>();
  for (const branch of branches) {
    if (branch.projectId && branch.branch)
      byBranch.set(branchIdentity(branch.projectId, branch.branch), branch);
    for (const placement of branch.placements) {
      if (placement.workspace) byWorkspace.set(placement.workspace.id, { branch, placement });
    }
  }
  const counts = new Map<string, number>();
  for (const issue of covered) {
    const key = issueIdentity(issue);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const items: IssueInventoryItem<T>[] = [];
  for (const issue of covered) {
    const projectName = input.projects[issue.projectId]?.name ?? issue.repository;
    if (!matchesIssue(issue, projectName, query)) continue;
    const tracked = isTracked(issue) ? issue : null;
    const cached = canonical.get(issueIdentity(issue));
    const work = isRepository(issue)
      ? issue
      : cached && (cached.sessionId || cached.branch || cached.workspaceId)
        ? cached
        : undefined;
    const locator: IssueLocator = tracked
      ? { kind: "tracked", id: tracked.id }
      : {
          kind: "repository",
          projectId: issue.projectId,
          number: issue.number,
          nodeId: issue.itemId,
        };
    const association = work ?? issue;
    // The repository endpoint resolves the effective link. If it reports several conflicting
    // remote links, don't opportunistically open whichever has a local session.
    const linked = work ? [work.branch] : [issue.branch, ...issue.branches];
    const own = association.workspaceId ? byWorkspace.get(association.workspaceId) : undefined;
    const branch =
      own?.branch ??
      linked
        .map((name) => (name ? byBranch.get(branchIdentity(issue.projectId, name)) : undefined))
        .find((b) => b !== undefined) ??
      null;
    const branchName = branch?.branch ?? linked.find((name) => name !== null) ?? null;
    const placement =
      own?.placement ??
      branch?.placements.find((p) => p.workspace?.id === branch.primary?.workspaceId) ??
      branch?.placements[0] ??
      null;
    const merged = issue.pullRequest?.state === "MERGED" || branch?.stage === "merged";
    const known = work?.sessionId ? input.sessions[work.sessionId] : undefined;
    // A returned session may not be synced yet. Prefer the canonical association, which includes
    // pending sessions; don't reopen a known archived or failed pre-workspace start.
    const sessionId =
      (work?.sessionId && !known?.archivedAt && !(known?.runtime === "failed" && !known.workspaceId)
        ? work.sessionId
        : null) ??
      branch?.primary?.id ??
      null;
    const notStarted = issueUnstarted(association) && !branch && !sessionId;
    if (subset === "notStarted" && (!notStarted || merged)) continue;
    const stage = merged
      ? "merged"
      : issue.pullRequest?.state === "OPEN" || branch?.stage === "in_review"
        ? "in_review"
        : notStarted
          ? "not_started"
          : "working";
    items.push({
      id: issueLocatorKey(locator),
      locator,
      issue,
      sourceId: tracked?.scopeId ?? null,
      projectId: issue.projectId,
      projectName,
      origin: tracked
        ? (input.scopes?.[tracked.scopeId]?.name ??
          (scope?.id === tracked.scopeId ? scope.name : `Source · ${tracked.scopeId}`))
        : "Repository issues",
      showOrigin: (counts.get(issueIdentity(issue)) ?? 0) > 1,
      branch,
      branchName,
      placement,
      sessionId,
      notStarted,
      merged,
      stage,
    });
  }
  return items.sort(
    (a, b) =>
      (sort === "priority" ? rank(a.issue) - rank(b.issue) : 0) ||
      byNumber(a.issue, b.issue) ||
      a.id.localeCompare(b.id),
  );
}
