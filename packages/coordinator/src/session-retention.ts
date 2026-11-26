import {
  buildBranches,
  INPUT_ATTENTION_REASONS,
  isLiveRuntime,
  type Session,
} from "@switchyard/protocol";
import type { AttentionService } from "./attention.js";
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
 * Kept: a branch's primary (so every branch can be resumed), live sessions, task sessions (the task
 * owns them) and sessions with an open interaction. A pin is membership of a view only: it does not
 * keep a session, and archiving removes it from views. Archiving hides a session; it is unarchived
 * when its Pi comes back, or by hand.
 */
export function archiveEndedSessions(store: Store, days = sessionArchiveDays(store)): Session[] {
  if (days <= 0) return [];
  return store.tx(() => {
    const now = store.nowIso();
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const sessions = store.sessions.list("archived_at IS NULL");
    const waiting = new Set(
      store.interactions
        .list("state IN ('pending', 'unsupported')")
        .filter((i) => i.state === "pending" || i.resolution === null)
        .map((i) => i.sessionId),
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
      !waiting.has(s.id);
    const archived = new Map<string, Session>();
    const archive = (s: Session) => {
      archived.set(s.id, store.putSession({ ...s, archivedAt: now }));
    };
    for (const b of branches) for (const s of b.extras) if (stale(s)) archive(s);
    const known = new Map(sessions.map((s) => [s.id, s]));
    for (const b of branches) {
      for (const s of b.subagents) {
        if (isLiveRuntime(s.runtime) || waiting.has(s.id)) continue;
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

/**
 * Clear state left behind by older releases, at startup and with each retention sweep:
 *
 * - questions of sessions whose Pi is gone (a terminal-only dialog open when Pi exited, a question
 *   an adapter raised): their interactions expire and their input attention is resolved, so they
 *   no longer show "Needs input" or keep the session under Active or out of retention;
 * - pins of archived (or deleted) sessions.
 *
 * Idempotent; writes go through the store, so clients see them as ordinary updates.
 */
export function sweepStaleSessionState(
  store: Store,
  attention: AttentionService,
): { sessions: number; pins: number } {
  return store.tx(() => {
    const ids = new Set<string>();
    const reasons = INPUT_ATTENTION_REASONS.map(() => "?").join(", ");
    for (const a of store.attention.list(
      `resolved_at IS NULL AND session_id IS NOT NULL AND reason IN (${reasons})`,
      [...INPUT_ATTENTION_REASONS],
    ))
      ids.add(a.sessionId!);
    for (const i of store.interactions.list("state IN ('pending', 'unsupported')"))
      if (i.state === "pending" || i.resolution === null) ids.add(i.sessionId);
    let sessions = 0;
    for (const id of ids) {
      const s = store.sessions.get(id);
      if (s && isLiveRuntime(s.runtime)) continue;
      const r = attention.endSessionInput(id);
      if (r.interactions + r.attention > 0) sessions++;
    }
    let pins = 0;
    for (const v of store.views.list()) {
      const kept = v.sessionIds.filter((id) => {
        const s = store.sessions.get(id);
        return !!s && s.archivedAt === null;
      });
      if (kept.length === v.sessionIds.length) continue;
      pins += v.sessionIds.length - kept.length;
      store.putView({ ...v, sessionIds: kept, updatedAt: store.nowIso() });
    }
    return { sessions, pins };
  });
}
