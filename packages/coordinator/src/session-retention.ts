import { buildBranches, isLiveRuntime, type Session } from "@switchyard/protocol";
import type { Store } from "./store.js";

/** Ended sessions that are not their branch's primary are archived after this many days. */
export const DEFAULT_SESSION_ARCHIVE_DAYS = 3;

/**
 * Archive the ended sessions nobody will come back to, so a branch that sees one session after
 * another (a main checkout) keeps its latest one and not a growing pile:
 *
 * - an ended session that is not its branch's primary, idle for longer than the window;
 * - an ended subagent idle for longer than the window, or whose parent is archived.
 *
 * Kept: a branch's primary (so every branch can be resumed), live sessions, sessions pinned to a
 * view, task sessions (the task owns them) and sessions with an open interaction. Archiving hides a
 * session; it is unarchived when its Pi comes back, or by hand.
 */
export function archiveEndedSessions(store: Store, days = sessionArchiveDays(store)): Session[] {
  if (days <= 0) return [];
  return store.tx(() => {
    const now = store.nowIso();
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const sessions = store.sessions.list("archived_at IS NULL");
    const pinned = new Set(store.views.list().flatMap((v) => v.sessionIds));
    const waiting = new Set(
      store.interactions.list("state IN ('pending', 'unsupported')").map((i) => i.sessionId),
    );
    const { branches } = buildBranches({
      workspaces: store.workspaces.list("archived_at IS NULL"),
      sessions,
      issues: [],
    });
    const stale = (s: Session) =>
      !isLiveRuntime(s.runtime) &&
      s.lastActivityAt < cutoff &&
      s.taskId === null &&
      !pinned.has(s.id) &&
      !waiting.has(s.id);
    const archived = new Map<string, Session>();
    const archive = (s: Session) => {
      archived.set(s.id, store.putSession({ ...s, archivedAt: now }));
    };
    for (const b of branches) for (const s of b.extras) if (stale(s)) archive(s);
    const known = new Map(sessions.map((s) => [s.id, s]));
    for (const b of branches) {
      for (const s of b.subagents) {
        if (isLiveRuntime(s.runtime) || waiting.has(s.id) || pinned.has(s.id)) continue;
        const parentGone =
          !!s.parentSessionId && (archived.has(s.parentSessionId) || !known.has(s.parentSessionId));
        if (parentGone || stale(s)) archive(s);
      }
    }
    return [...archived.values()];
  });
}

export function sessionArchiveDays(store: Store): number {
  return store.getSetting("sessionArchiveDays", DEFAULT_SESSION_ARCHIVE_DAYS);
}
