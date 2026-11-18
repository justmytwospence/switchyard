import type { Session, TrackedIssue } from "@switchyard/protocol";
import { apiPost } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

const issue = (id: string) => `/api/issues/${encodeURIComponent(id)}`;

/** Start or open an issue's branch; returns the session to show. */
export async function openIssue(
  id: string,
  body: { hostId?: string; viewId?: string } = {},
): Promise<Session> {
  const r = await apiPost<{ session: Session; created: boolean }>(`${issue(id)}/open`, body);
  useSyncStore.getState().upsertSessionIfMissing(r.session);
  return r.session;
}

/** Move an issue's card to another column of its GitHub Projects board. */
export function setIssueStatus(id: string, status: string): Promise<TrackedIssue> {
  return apiPost<TrackedIssue>(`${issue(id)}/status`, { status });
}
