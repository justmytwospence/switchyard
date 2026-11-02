import { newId, type Session, TranscriptItem } from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import type { Store } from "../store.js";

export const SUBAGENT_READ_ONLY = "Subagent: view only. Live control is not supported.";

type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

/**
 * A parent session reported a subagent with a native session file: find or create the read-only
 * Session for that file (provenance `subagent`, on the parent's host, project and workspace) and
 * return the item with `linkedSessionId` filled in. Runs inside the projection transaction.
 */
export function linkSubagentItem(
  store: Store,
  hostId: string,
  parent: Session | undefined,
  item: SubagentItem,
): SubagentItem {
  const file = item.data.sessionFile;
  if (!file || !parent) return item;
  const now = store.nowIso();
  let sub = store.sessionByNativeFile(hostId, file);
  if (!sub) {
    const host = store.hosts.get(hostId);
    sub = store.putSession({
      id: newId("ses"),
      title: `Subagent: ${item.data.label}`,
      subtitle: item.data.status,
      hostId,
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      cwd: parent.cwd,
      // The native session id comes from the file header on the first read.
      nativeHandle: { sessionId: "", sessionFile: file },
      profileSnapshot: parent.profileSnapshot,
      runtime: "stopped",
      runtimeDetail: SUBAGENT_READ_ONLY,
      connectivity: host?.connectivity ?? parent.connectivity,
      runId: null,
      taskId: null,
      provenance: "subagent",
      readOnly: true,
      lastActivityAt: now,
      archivedAt: null,
      queue: { steering: [], followUp: [] },
      stats: null,
      lastAssistantText: null,
      createdAt: now,
    });
  } else if (sub.provenance === "subagent" && sub.subtitle !== item.data.status) {
    sub = store.putSession({ ...sub, subtitle: item.data.status, lastActivityAt: now });
  }
  if (item.data.linkedSessionId === sub.id) return item;
  return { ...item, data: { ...item.data, linkedSessionId: sub.id } };
}

/**
 * Re-read a subagent session's transcript from its native file on the host (opening it shows
 * the subagent's progress). Keeps the cached transcript when the host is offline or the read
 * fails. Returns whether it refreshed.
 */
export async function refreshSubagentTranscript(
  ctx: CoordinatorContext,
  session: Session,
): Promise<boolean> {
  if (session.provenance !== "subagent" || !session.readOnly || !session.nativeHandle) {
    return false;
  }
  if (!ctx.hostHub.isConnected(session.hostId)) return false;
  let raw: unknown;
  try {
    raw = await ctx.hostHub.request(session.hostId, {
      type: "session.readNative",
      sessionFile: session.nativeHandle.sessionFile,
    });
  } catch (err) {
    ctx.log.info({ err, sessionId: session.id }, "subagent transcript refresh failed");
    return false;
  }
  const result = (raw ?? {}) as { sessionId?: unknown; items?: unknown };
  const rawItems = (Array.isArray(result.items) ? result.items : []) as Record<string, unknown>[];
  const items: TranscriptItem[] = [];
  rawItems.forEach((r, i) => {
    const parsed = TranscriptItem.safeParse({
      ...r,
      // Stable ids, so a refresh replaces items instead of duplicating them for clients.
      id: `itm_${session.id}_${i}`,
      order: i,
      at: r.at ?? session.createdAt,
      sessionId: session.id,
    });
    if (parsed.success) items.push(parsed.data);
  });
  ctx.store.tx(() => {
    const cur = ctx.store.sessions.get(session.id);
    if (!cur) return;
    ctx.store.replaceItems(session.id, items);
    const nativeId = typeof result.sessionId === "string" ? result.sessionId : "";
    const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant");
    const next: Session = {
      ...cur,
      nativeHandle:
        nativeId && cur.nativeHandle && cur.nativeHandle.sessionId !== nativeId
          ? { ...cur.nativeHandle, sessionId: nativeId }
          : cur.nativeHandle,
      lastAssistantText:
        lastAssistant?.kind === "assistant" ? lastAssistant.data.text : cur.lastAssistantText,
    };
    if (JSON.stringify(next) !== JSON.stringify(cur)) ctx.store.putSession(next);
  });
  return true;
}
