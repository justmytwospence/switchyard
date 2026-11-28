import { IssueDescriptionResult, type Session, type TrackedIssue } from "@switchyard/protocol";
import { apiDelete, apiGet, apiPost } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

const issue = (id: string) => `/api/issues/${encodeURIComponent(id)}`;

export async function getIssueDescription(id: string, signal: AbortSignal) {
  return IssueDescriptionResult.parse(await apiGet(`${issue(id)}/description`, undefined, signal));
}

/** Start or open an issue's branch; returns the session to show and whether it is new. */
export async function openIssue(
  id: string,
  body: { hostId?: string; scopeId?: string; prompt?: string; profileId?: string } = {},
): Promise<{ session: Session; created: boolean }> {
  const r = await apiPost<{ session: Session; created: boolean }>(`${issue(id)}/open`, body);
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
