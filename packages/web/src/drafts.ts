import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Composer drafts and collected review comments, per session, in localStorage.
 * Drafts survive navigation, transient errors and reconnects (spec 18).
 */

const DRAFT_PREFIX = "sy:draft:";
const REVIEW_PREFIX = "sy:review:";
export const DRAFT_DEBOUNCE_MS = 300;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage full or unavailable: drafts are best effort
  }
}

export function loadDraft(sessionId: string): string {
  return read(DRAFT_PREFIX + sessionId) ?? "";
}

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string }>();

/** Save a draft after 300 ms of inactivity. */
export function saveDraft(sessionId: string, text: string): void {
  const prev = pending.get(sessionId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    write(DRAFT_PREFIX + sessionId, text);
  }, DRAFT_DEBOUNCE_MS);
  pending.set(sessionId, { timer, text });
}

/** Write any pending debounced draft now (on unmount or pagehide). */
export function flushDraft(sessionId: string): void {
  const p = pending.get(sessionId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(sessionId);
  write(DRAFT_PREFIX + sessionId, p.text);
}

/** Save a draft immediately (before navigating to the session). */
export function setDraftNow(sessionId: string, text: string): void {
  const p = pending.get(sessionId);
  if (p) clearTimeout(p.timer);
  pending.delete(sessionId);
  write(DRAFT_PREFIX + sessionId, text);
}

export function clearDraft(sessionId: string): void {
  const p = pending.get(sessionId);
  if (p) clearTimeout(p.timer);
  pending.delete(sessionId);
  write(DRAFT_PREFIX + sessionId, null);
}

/** Write every debounced draft now (before a page reload or unload). */
export function flushAllDrafts(): void {
  for (const id of [...pending.keys()]) flushDraft(id);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAllDrafts);
}

/**
 * Draft state for a session's composer: `[text, setText, clear]`. Loads the
 * saved draft when the session changes and saves on every change (debounced).
 */
export function useDraft(sessionId: string | null): [string, (t: string) => void, () => void] {
  const [text, setTextState] = useState(() => (sessionId ? loadDraft(sessionId) : ""));
  const current = useRef(sessionId);
  useEffect(() => {
    current.current = sessionId;
    setTextState(sessionId ? loadDraft(sessionId) : "");
    return () => {
      if (sessionId) flushDraft(sessionId);
    };
  }, [sessionId]);
  const setText = useCallback((t: string) => {
    setTextState(t);
    if (current.current) saveDraft(current.current, t);
  }, []);
  const clear = useCallback(() => {
    setTextState("");
    if (current.current) clearDraft(current.current);
  }, []);
  return [text, setText, clear];
}

/* Review comments collected in Changes and sent as one follow-up (spec 11). */

export interface ReviewComment {
  id: string;
  file: string;
  /** New-side line number, or null for a file-level comment. */
  line: number | null;
  /** The quoted diff line, for context in the follow-up. */
  excerpt: string | null;
  text: string;
  createdAt: string;
}

export function loadReviewComments(sessionId: string): ReviewComment[] {
  const raw = read(REVIEW_PREFIX + sessionId);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as ReviewComment[]) : [];
  } catch {
    return [];
  }
}

export function saveReviewComments(sessionId: string, comments: ReviewComment[]): void {
  write(REVIEW_PREFIX + sessionId, comments.length ? JSON.stringify(comments) : null);
}

export function clearReviewComments(sessionId: string): void {
  write(REVIEW_PREFIX + sessionId, null);
}

/** Format collected comments as one follow-up message. */
export function formatReviewFollowUp(comments: ReviewComment[]): string {
  const lines = ["Please address these review comments:", ""];
  for (const c of comments) {
    const where = c.line === null ? c.file : `${c.file}:${c.line}`;
    lines.push(`- ${where}: ${c.text}`);
    if (c.excerpt) lines.push(`  > ${c.excerpt}`);
  }
  return lines.join("\n");
}

export function useReviewComments(sessionId: string | null) {
  const [comments, setComments] = useState<ReviewComment[]>(() =>
    sessionId ? loadReviewComments(sessionId) : [],
  );
  useEffect(() => {
    setComments(sessionId ? loadReviewComments(sessionId) : []);
  }, [sessionId]);
  const update = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      if (sessionId) saveReviewComments(sessionId, next);
    },
    [sessionId],
  );
  const add = useCallback(
    (c: Omit<ReviewComment, "id" | "createdAt">) => {
      const comment: ReviewComment = {
        ...c,
        id: `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        createdAt: new Date().toISOString(),
      };
      setComments((prev) => {
        const next = [...prev, comment];
        if (sessionId) saveReviewComments(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );
  const remove = useCallback(
    (id: string) => {
      setComments((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (sessionId) saveReviewComments(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );
  const clear = useCallback(() => update([]), [update]);
  return { comments, add, remove, clear, set: update };
}
