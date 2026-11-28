import {
  type Branch,
  type BranchPlacement,
  type BranchStage,
  buildBranches,
  compareIssues,
  issueInScope,
  issueUnstarted,
  type Project,
  type Scope,
  type Session,
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

export interface IssueInventoryItem {
  /** Tracked ID, which includes the source identity; never deduplicate by repo and number. */
  id: string;
  issue: TrackedIssue;
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

function matchesIssue(issue: TrackedIssue, projectName: string, query: string): boolean {
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

const byNumber = (a: TrackedIssue, b: TrackedIssue) =>
  a.repository.localeCompare(b.repository) || a.number - b.number;
const branchIdentity = (projectId: string, branch: string) => JSON.stringify([projectId, branch]);
const issueIdentity = (issue: TrackedIssue) =>
  JSON.stringify([issue.repository.toLowerCase(), issue.number]);

/** The same tracked issue menu for every layout, independent of session/branch membership. */
export function issueInventory(
  input: DiscoveryInput,
  options: IssueInventoryOptions,
): IssueInventoryItem[] {
  const { scope, projectId, subset, sort } = options;
  const query = options.query.trim().toLowerCase();
  const covered = Object.values(input.issues).filter(
    (issue) =>
      (!scope || issueInScope(scope, issue)) && (!projectId || issue.projectId === projectId),
  );
  if (covered.length === 0) return [];

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

  const items: IssueInventoryItem[] = [];
  for (const issue of covered) {
    const projectName = input.projects[issue.projectId]?.name ?? issue.repository;
    if (!matchesIssue(issue, projectName, query)) continue;
    const linked = [issue.branch, ...issue.branches];
    const own = issue.workspaceId ? byWorkspace.get(issue.workspaceId) : undefined;
    const branch =
      own?.branch ??
      linked
        .map((name) => (name ? byBranch.get(branchIdentity(issue.projectId, name)) : undefined))
        .find((b) => b !== undefined) ??
      null;
    const branchName = branch?.branch ?? issue.branch ?? issue.branches[0] ?? null;
    const placement =
      own?.placement ??
      branch?.placements.find((p) => p.workspace?.id === branch.primary?.workspaceId) ??
      branch?.placements[0] ??
      null;
    const merged = issue.pullRequest?.state === "MERGED" || branch?.stage === "merged";
    const notStarted = issueUnstarted(issue) && !branch;
    if (subset === "notStarted" && (!notStarted || merged)) continue;
    const stage = merged
      ? "merged"
      : issue.pullRequest?.state === "OPEN" || branch?.stage === "in_review"
        ? "in_review"
        : notStarted
          ? "not_started"
          : "working";
    items.push({
      id: issue.id,
      issue,
      projectId: issue.projectId,
      projectName,
      origin:
        input.scopes?.[issue.scopeId]?.name ??
        (scope?.id === issue.scopeId ? scope.name : `Source · ${issue.scopeId}`),
      showOrigin: (counts.get(issueIdentity(issue)) ?? 0) > 1,
      branch,
      branchName,
      placement,
      sessionId: branch?.primary?.id ?? null,
      notStarted,
      merged,
      stage,
    });
  }
  const compare = sort === "priority" ? compareIssues : byNumber;
  return items.sort((a, b) => compare(a.issue, b.issue) || a.id.localeCompare(b.id));
}
