import {
  IssueDescriptionResult,
  type OpenIssueRequest,
  RepoIssueItem,
  RepoIssuesPage,
  type Session,
  type TrackedIssue,
} from "@switchyard/protocol";
import { apiDelete, apiGet, apiPost } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import type { IssueLocator } from "../discovery/model";

const issue = (id: string) => `/api/issues/${encodeURIComponent(id)}`;
const repository = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/issues`;
const issuePath = (locator: IssueLocator) =>
  locator.kind === "tracked"
    ? issue(locator.id)
    : `${repository(locator.projectId)}/${locator.number}`;

export async function getIssueDescription(locator: IssueLocator, signal: AbortSignal) {
  return IssueDescriptionResult.parse(
    await apiGet(`${issuePath(locator)}/description`, undefined, signal),
  );
}

export async function getRepositoryIssues(
  projectId: string,
  after: string | null,
  signal: AbortSignal,
) {
  return RepoIssuesPage.parse(await apiGet(repository(projectId), { after }, signal));
}

export async function getSessionIssueWork(id: string, signal: AbortSignal) {
  return RepoIssueItem.nullable().parse(
    await apiGet(`/api/sessions/${encodeURIComponent(id)}/issue-work`, undefined, signal),
  );
}

/** Start or open an issue's branch; returns the session to show and whether it is new. */
export async function openIssue(
  locator: IssueLocator,
  body: OpenIssueRequest = {},
): Promise<{ session: Session; created: boolean }> {
  const r = await apiPost<{ session: Session; created: boolean }>(
    `${issuePath(locator)}/open`,
    locator.kind === "tracked" ? body : { ...body, expectedNodeId: locator.nodeId },
  );
  useSyncStore.getState().upsertSessionIfMissing(r.session);
  return r;
}

/** Move an issue's card to another column of its GitHub Projects board. */
export function setIssueStatus(id: string, status: string): Promise<TrackedIssue> {
  return apiPost<TrackedIssue>(`${issue(id)}/status`, { status });
}

/** Link a worktree's branch to a not-started issue. */
export function linkIssue(id: string, workspaceId: string): Promise<TrackedIssue> {
  return apiPost<TrackedIssue>(`${issue(id)}/link`, { workspaceId });
}

/** Undo a link GitHub does not know about. */
export function unlinkIssue(id: string): Promise<TrackedIssue> {
  return apiDelete<TrackedIssue>(`${issue(id)}/link`);
}
