import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isDocumentPresentation } from "../../components/intent/InteractionCard";
import { Button } from "../../components/ui/Button";
import { ErrorState, InteractionPending, LoadingState } from "../../components/ui/states";
import { cn } from "../../lib/cn";
import { usePendingInteractions, useStreams, useSyncStore, useTranscript } from "../../sync/store";
import { buildTimeline, countAfter, interactionDomId } from "./model";
import { StartingCard, TimelineRow } from "./TranscriptItems";

/**
 * Center `target` inside `container` by scrolling only the container
 * (scrollIntoView would also scroll overflow-hidden ancestors of the layout).
 */
function scrollWithin(container: HTMLElement, target: HTMLElement, smooth = false): void {
  const c = container.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const top = container.scrollTop + (t.top - c.top) - Math.max(0, (c.height - t.height) / 2);
  container.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}

/** Within this distance of the bottom the view sticks to new content. */
export const STICK_THRESHOLD_PX = 48;
const LOAD_OLDER_THRESHOLD_PX = 160;
const HIGHLIGHT_MS = 4000;

export interface TranscriptProps {
  sessionId: string;
  draftEmpty: boolean;
  onUseSuggestion: (text: string) => void;
  /** Answer controls hidden with this reason (read-only view, host offline). */
  interactionReadOnly: string | null;
  /** `?interaction=<id>` deep link: scroll to and highlight it once. */
  focusInteractionId: string | null;
  className?: string;
}

/**
 * Session transcript with scroll anchoring: it follows new content only when
 * the reader is already at the bottom; otherwise "Jump to latest (N)" shows
 * the unseen count and the viewport stays put. Loading older pages keeps the
 * reading position.
 */
export function Transcript({
  sessionId,
  draftEmpty,
  onUseSuggestion,
  interactionReadOnly,
  focusInteractionId,
  className,
}: TranscriptProps) {
  const t = useTranscript(sessionId);
  const streams = useStreams(sessionId);
  const pending = usePendingInteractions(sessionId);
  const session = useSyncStore((s) => s.sessions[sessionId]);
  const starting = session?.runtime === "starting";
  const loadOlder = useSyncStore((s) => s.loadOlderTranscript);
  const loadTranscript = useSyncStore((s) => s.loadTranscript);
  const entries = useMemo(
    () => buildTimeline(t.items, streams, pending),
    [t.items, streams, pending],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [baselineKey, setBaselineKey] = useState<string | null>(null);
  const prependHeight = useRef<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  const lastKey = entries.length ? entries[entries.length - 1]!.key : null;
  const firstKey = entries.length ? entries[0]!.key : null;
  const streamSize = streams.reduce(
    (n, s) => n + s.text.length + s.thinking.length + s.toolArgs.length + s.toolOutput.length,
    0,
  );

  // Reset per session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the session changes
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    setBaselineKey(null);
    prependHeight.current = null;
  }, [sessionId]);

  const requestOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !t.hasMore || t.loading) return;
    prependHeight.current = el.scrollHeight;
    void loadOlder(sessionId);
  }, [t.hasMore, t.loading, loadOlder, sessionId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const at = dist <= STICK_THRESHOLD_PX;
    if (at !== atBottomRef.current) {
      atBottomRef.current = at;
      setAtBottom(at);
      setBaselineKey(at ? null : lastKey);
    }
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) requestOlder();
  };

  // Stick to the bottom when already there; keep the reading position when older items load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when content changes size
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependHeight.current !== null) {
      const delta = el.scrollHeight - prependHeight.current;
      prependHeight.current = null;
      if (!atBottomRef.current && delta > 0) {
        el.scrollTop += delta;
        return;
      }
    }
    if (atBottomRef.current) {
      // A new plan awaiting approval: show its start (the answer bar is pinned), not its end.
      const last = entries[entries.length - 1];
      const doc =
        last?.type === "interaction" && isDocumentPresentation(last.interaction.presentation)
          ? el.querySelector<HTMLElement>('[data-testid="document-interaction"]:last-of-type')
          : null;
      if (doc) el.scrollTop = Math.max(0, doc.offsetTop - 8);
      else el.scrollTop = el.scrollHeight;
    }
  }, [entries.length, lastKey, firstKey, streamSize, t.loaded]);

  // Opening a session with a plan awaiting approval lands on the plan, once.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!t.loaded || landed.current === sessionId) return;
    const doc = [...pending].reverse().find((i) => isDocumentPresentation(i.presentation));
    landed.current = sessionId;
    if (!doc || focusInteractionId) return;
    const el = document.getElementById(interactionDomId(doc.id));
    if (!el || !scrollRef.current) return;
    atBottomRef.current = false;
    setAtBottom(false);
    setBaselineKey(lastKey);
    scrollRef.current.scrollTop = Math.max(0, el.offsetTop - 8);
  });

  // Deep link: scroll to and highlight the interaction once it is rendered.
  const handled = useRef<string | null>(null);
  const olderAttempts = useRef(0);
  useLayoutEffect(() => {
    if (!focusInteractionId || handled.current === focusInteractionId || !t.loaded) return;
    const target = document.getElementById(interactionDomId(focusInteractionId));
    if (!target) {
      // It may be in an older page: load a few pages back.
      if (t.hasMore && !t.loading && olderAttempts.current < 5) {
        olderAttempts.current++;
        requestOlder();
      }
      return;
    }
    handled.current = focusInteractionId;
    olderAttempts.current = 0;
    atBottomRef.current = false;
    setAtBottom(false);
    setBaselineKey(lastKey);
    if (scrollRef.current) scrollWithin(scrollRef.current, target);
    setHighlight(focusInteractionId);
  });
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setAtBottom(true);
    setBaselineKey(null);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const openFirstPending = () => {
    const first = pending[0];
    if (!first) return;
    const el = document.getElementById(interactionDomId(first.id));
    if (!el) return;
    atBottomRef.current = false;
    setAtBottom(false);
    setBaselineKey(lastKey);
    if (scrollRef.current) scrollWithin(scrollRef.current, el, true);
    setHighlight(first.id);
    // Move focus to the first control of the question for keyboard users.
    const control = el.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])",
    );
    (control ?? el).focus({ preventScroll: true });
  };

  const unseen = atBottom ? 0 : countAfter(entries, baselineKey);

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {pending.length > 0 && (
        <div data-testid="needs-answer-strip" className="shrink-0 px-3 pt-2">
          <InteractionPending
            count={pending.length}
            onOpen={openFirstPending}
            label={
              pending.length === 1
                ? `Needs your answer: ${pending[0]!.title}`
                : `${pending.length} questions need your answer`
            }
          />
        </div>
      )}
      <div
        ref={scrollRef}
        data-testid="transcript"
        role="log"
        aria-live="off"
        aria-label="Transcript"
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 md:px-6 [overflow-anchor:none] focus-visible:outline-offset-[-2px]"
      >
        <div className="flex w-full min-w-0 flex-col gap-3">
          {t.loaded && t.hasMore && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" busy={t.loading} onClick={requestOlder}>
                Load earlier messages
              </Button>
            </div>
          )}
          {t.error && t.loaded && (
            <ErrorState
              compact
              title="Could not load more of the transcript"
              error={t.error}
              onRetry={requestOlder}
            />
          )}
          {!t.loaded && t.error ? (
            <ErrorState
              title="Could not load the transcript"
              error={t.error}
              onRetry={() => void loadTranscript(sessionId, { force: true })}
            />
          ) : !t.loaded && entries.length === 0 ? (
            <LoadingState label="Loading transcript…" />
          ) : entries.length === 0 && !starting ? (
            <p className="py-10 text-center text-sm text-muted">
              No messages yet. Write a prompt below to start.
            </p>
          ) : (
            entries.map((entry) => (
              <TimelineRow
                key={entry.key}
                entry={entry}
                sessionId={sessionId}
                interactionReadOnly={interactionReadOnly}
                draftEmpty={draftEmpty}
                onUseSuggestion={onUseSuggestion}
                highlightInteractionId={highlight}
              />
            ))
          )}
          {starting && (
            <StartingCard
              sessionId={sessionId}
              detail={session?.runtimeDetail ?? null}
              showPrompt={entries.length === 0}
            />
          )}
          {t.stale && t.loaded && (
            <p role="status" className="text-center text-xs text-muted">
              Refreshing transcript…
            </p>
          )}
        </div>
      </div>
      {!atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            data-testid="jump-to-latest"
            size="sm"
            variant="secondary"
            className="pointer-events-auto shadow-pop"
            icon={<ArrowDown className="size-4" />}
            onClick={jumpToLatest}
          >
            Jump to latest{unseen > 0 ? ` (${unseen})` : ""}
          </Button>
        </div>
      )}
    </div>
  );
}
