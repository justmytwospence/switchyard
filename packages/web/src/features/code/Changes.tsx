import type { DiffFile as ChangedFile, DiffResult } from "@switchyard/protocol";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHideBottomNav } from "../../app/chrome";
import { DiffView } from "../../components/intent/DiffView";
import { type DiffFile, parseUnifiedDiff } from "../../components/intent/diff";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import {
  EmptyState,
  ErrorState,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { TextArea } from "../../components/ui/TextArea";
import { formatReviewFollowUp, type ReviewComment, useReviewComments } from "../../drafts";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/time";
import { errorMessage, isApiError } from "../../sync/api";
import { codeApi } from "./api";
import { useCodeContext } from "./context";
import type { SessionContext } from "./hooks";
import { useMutation } from "./hooks";
import { composerBlockReason, isBusy } from "./model";

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

export interface WorkspaceDiff {
  result: DiffResult | null;
  parsed: Map<string, DiffFile>;
  loading: boolean;
  error: unknown;
  fetchedAt: string | null;
  /** The workspace changed (git state event) after the last fetch. */
  outdated: boolean;
  refresh: () => void;
}

/** Changed files and the patch of a workspace; refetches on demand. */
export function useWorkspaceDiff(ctx: SessionContext): WorkspaceDiff {
  const ws = ctx.workspace;
  const connected = ctx.link === "connected";
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const wsId = ws?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce triggers a refetch
  useEffect(() => {
    if (!wsId || !connected) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    codeApi
      .diff(wsId, undefined, ac.signal)
      .then((r) => {
        setResult(r);
        setFetchedAt(new Date().toISOString());
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [wsId, connected, nonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear when the workspace changes
  useEffect(() => {
    setResult(null);
    setFetchedAt(null);
  }, [wsId]);

  const parsed = useMemo(() => {
    const m = new Map<string, DiffFile>();
    if (result?.patch) for (const f of parseUnifiedDiff(result.patch)) m.set(f.path, f);
    return m;
  }, [result]);

  const outdated = !!ws && !!fetchedAt && ws.updatedAt > fetchedAt;
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { result, parsed, loading, error, fetchedAt, outdated, refresh };
}

/** Parsed diff of one file: from the full patch, else fetched with `?file=`. */
function useFileDiff(ctx: SessionContext, diff: WorkspaceDiff, path: string | null) {
  const fromPatch = path ? diff.parsed.get(path) : undefined;
  const [fetched, setFetched] = useState<{ path: string; file: DiffFile | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const wsId = ctx.workspace?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on retry and after a refresh
  useEffect(() => {
    if (!path || fromPatch || !wsId || ctx.link !== "connected") return;
    const ac = new AbortController();
    setError(null);
    codeApi
      .diff(wsId, path, ac.signal)
      .then((r) => {
        const files = r.patch ? parseUnifiedDiff(r.patch) : [];
        setFetched({ path, file: files.find((f) => f.path === path) ?? files[0] ?? null });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [path, fromPatch, wsId, ctx.link, nonce, diff.fetchedAt]);
  if (!path) return { file: null, loading: false, error: null, retry: () => {} };
  if (fromPatch) return { file: fromPatch, loading: false, error: null, retry: () => {} };
  const mine = fetched?.path === path ? fetched : null;
  return {
    file: mine?.file ?? null,
    loading: !mine && !error,
    error,
    retry: () => setNonce((n) => n + 1),
  };
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<ChangedFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  binary: "Binary",
};

function ChangedFileList({
  files,
  selected,
  onSelect,
  commentCounts,
  large,
}: {
  files: ChangedFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  commentCounts: Map<string, number>;
  large?: boolean;
}) {
  return (
    <ul aria-label="Changed files" className="flex min-w-0 flex-col">
      {files.map((f) => {
        const comments = commentCounts.get(f.path) ?? 0;
        return (
          <li key={f.path} className="min-w-0">
            <button
              type="button"
              aria-current={selected === f.path ? "true" : undefined}
              onClick={() => onSelect(f.path)}
              className={cn(
                "tap flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-2",
                large ? "min-h-12 py-2" : "py-1.5",
                selected === f.path && "bg-accent-soft",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <span className="block text-xs text-muted">
                  {STATUS_LABEL[f.status]}
                  {comments > 0 && ` · ${comments} comment${comments === 1 ? "" : "s"}`}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-success">
                  +{f.added}
                  <span className="sr-only"> added</span>
                </span>{" "}
                <span className="text-danger">
                  -{f.deleted}
                  <span className="sr-only"> deleted</span>
                </span>
              </span>
              {large && <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface CommentDraft {
  file: string;
  line: number | null;
  excerpt: string | null;
}

/** Diff of one file; clicking a line opens a comment form. */
function FileDiffView({
  ctx,
  diff,
  path,
  comments,
  onComment,
}: {
  ctx: SessionContext;
  diff: WorkspaceDiff;
  path: string;
  comments: ReviewComment[];
  onComment: (d: CommentDraft) => void;
}) {
  const fd = useFileDiff(ctx, diff, path);
  if (fd.error) {
    return (
      <ErrorState compact title="Could not load this diff" error={fd.error} onRetry={fd.retry} />
    );
  }
  if (fd.loading) return <LoadingState label="Loading diff…" />;
  if (!fd.file) {
    return <p className="text-sm text-muted">No textual diff for this file.</p>;
  }
  const marked = new Set(comments.filter((c) => c.file === path).map((c) => c.line));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DiffView
        files={[fd.file]}
        onLineClick={({ file, line }) =>
          onComment({ file, line: line.newLine ?? line.oldLine, excerpt: line.text })
        }
        isLineMarked={({ line }) => marked.has(line.newLine ?? line.oldLine)}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={<MessageSquarePlus className="size-4" />}
        onClick={() => onComment({ file: path, line: null, excerpt: null })}
        className="self-start"
      >
        Comment on this file
      </Button>
    </div>
  );
}

function CommentForm({
  draft,
  mobile,
  onClose,
  onSave,
}: {
  draft: CommentDraft | null;
  mobile: boolean;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset for each new target line
  useEffect(() => setText(""), [draft]);
  const Surface = mobile ? Sheet : Dialog;
  const where = draft ? (draft.line === null ? draft.file : `${draft.file}:${draft.line}`) : "";
  return (
    <Surface
      open={!!draft}
      onClose={onClose}
      title="Add review comment"
      description={where}
      initialFocus={ref}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
            Add comment
          </Button>
        </>
      }
    >
      {draft?.excerpt && (
        <pre className="mb-2 max-w-full overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs">
          {draft.excerpt}
        </pre>
      )}
      <label htmlFor="sy-review-comment" className="sr-only">
        Comment
      </label>
      <TextArea
        id="sy-review-comment"
        ref={ref}
        minRows={3}
        value={text}
        placeholder="What should change here?"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-1 text-xs text-muted">
        Comments are collected and sent together, never one at a time.
      </p>
    </Surface>
  );
}

/** Collected comments with "Send as one follow-up" and, for a task in Review, the review actions. */
function ReviewPanel({
  ctx,
  review,
}: {
  ctx: SessionContext;
  review: ReturnType<typeof useReviewComments>;
}) {
  const { session, task } = ctx;
  const { mobile } = useCodeContext();
  const [overall, setOverall] = useState("");
  const block = composerBlockReason({ session, hostLink: ctx.link, hostName: ctx.hostName });
  const send = useMutation(
    () =>
      codeApi.prompt(session.id, {
        text: formatReviewFollowUp(review.comments),
        mode: isBusy(session) ? "followUp" : "prompt",
      }),
    { success: "Review comments sent as one follow-up." },
  );
  const feedback = [
    ...(overall.trim() ? [overall.trim()] : []),
    ...review.comments.map((c) => {
      const where = c.line === null ? c.file : `${c.file}:${c.line}`;
      return `${where}: ${c.text}`;
    }),
  ];
  const requestChanges = useMutation(() => codeApi.requestChanges(task!.id, feedback), {
    success: "Changes requested. The task stays in Review until a new attempt starts.",
  });
  const accept = useMutation((confirm?: boolean) => codeApi.accept(task!.id, confirm), {
    success: "Task accepted and marked Done.",
  });
  const acceptNeedsConfirm =
    isApiError(accept.error, "invalid_transition") &&
    (accept.error.details as { needsConfirm?: boolean } | undefined)?.needsConfirm === true;
  const inReview = task?.state === "review";
  const sendBlocked = block?.reason ?? null;

  return (
    <section
      aria-label="Review"
      className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
    >
      <h3 className="text-sm font-semibold">
        Review comments{review.comments.length > 0 && ` (${review.comments.length})`}
      </h3>
      {review.comments.length === 0 ? (
        <p className="text-sm text-muted">
          {`${mobile ? "Tap" : "Click"} a line in the diff to comment. Comments go to Pi together as one message.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {review.comments.map((c) => (
            <li
              key={c.id}
              className="flex min-w-0 items-start gap-2 rounded-md border border-border px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-muted">
                  {c.line === null ? c.file : `${c.file}:${c.line}`}
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{c.text}</p>
              </div>
              <IconButton
                size="sm"
                label="Remove comment"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => review.remove(c.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {review.comments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={inReview ? "secondary" : "primary"}
            icon={<Send className="size-3.5" />}
            disabled={!!sendBlocked}
            busy={send.busy}
            onClick={() => void send.run().then((ok) => ok && review.clear())}
          >
            Send as one follow-up
          </Button>
          {review.comments.length > 0 && (
            <Button size="sm" variant="ghost" onClick={review.clear}>
              Clear all
            </Button>
          )}
        </div>
      )}
      {sendBlocked && review.comments.length > 0 && (
        <p className="text-xs text-muted">{sendBlocked}</p>
      )}
      {send.error !== null && (
        <ErrorState
          compact
          title="Comments not sent; they are kept."
          error={errorMessage(send.error)}
          onRetry={() => void send.run().then((ok) => ok && review.clear())}
        />
      )}

      {task && inReview && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold">Task review: {task.title}</h3>
          <label htmlFor="sy-overall-feedback" className="text-xs font-medium text-muted">
            Overall feedback (optional, sent with the comments above)
          </label>
          <TextArea
            id="sy-overall-feedback"
            minRows={2}
            value={overall}
            onChange={(e) => setOverall(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Undo2 className="size-3.5" />}
              disabled={feedback.length === 0}
              busy={requestChanges.busy}
              onClick={() =>
                void requestChanges.run().then((ok) => {
                  if (!ok) return;
                  review.clear();
                  setOverall("");
                })
              }
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Check className="size-3.5" />}
              busy={accept.busy}
              onClick={() => void accept.run(false)}
            >
              Accept task
            </Button>
          </div>
          {feedback.length === 0 && (
            <p className="text-xs text-muted">
              Add a comment or overall feedback to request changes.
            </p>
          )}
          <p className="text-xs text-muted">
            Accepting marks the task Done. It does not merge or push.
          </p>
          {requestChanges.error !== null && (
            <ErrorState
              compact
              title="Could not request changes"
              error={errorMessage(requestChanges.error)}
            />
          )}
          {accept.error !== null &&
            (acceptNeedsConfirm ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md bg-warning-soft p-2 text-sm"
              >
                <p className="break-words">{errorMessage(accept.error)}</p>
                <Button
                  size="sm"
                  variant="primary"
                  className="self-start"
                  busy={accept.busy}
                  onClick={() => void accept.run(true)}
                >
                  Accept anyway
                </Button>
              </div>
            ) : (
              <ErrorState compact title="Could not accept" error={errorMessage(accept.error)} />
            ))}
        </div>
      )}
      {task?.review.changesRequested && task.state === "review" && (
        <p className="text-xs text-muted">
          Changes requested. The task stays in Review until a new attempt is requested.
        </p>
      )}
    </section>
  );
}

function useCommentCounts(comments: ReviewComment[]) {
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.file, (m.get(c.file) ?? 0) + 1);
    return m;
  }, [comments]);
}

function ChangesUnavailable({ ctx }: { ctx: SessionContext }) {
  if (!ctx.workspace) {
    return (
      <UnsupportedCapability
        capability="Changes"
        reason={`This session is not linked to a Switchyard workspace (it runs in ${ctx.session.cwd}).`}
        fallback="Open a session in a project workspace to review changes."
      />
    );
  }
  return (
    <HostUnavailable
      compact
      hostName={ctx.hostName}
      connectivity={ctx.link === "reconnecting" ? "reconnecting" : "unreachable"}
      lastSeenAt={ctx.host?.lastSeenAt}
      detail="Changes are read from the host; they load when it reconnects."
    />
  );
}

function RefreshRow({ diff }: { diff: WorkspaceDiff }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
      <span className="min-w-0 flex-1">
        {diff.result ? `Against ${diff.result.base}` : ""}
        {diff.fetchedAt && ` · updated ${formatTime(diff.fetchedAt)}`}
        {diff.outdated && " · workspace changed since"}
      </span>
      <Button
        size="sm"
        variant={diff.outdated ? "secondary" : "ghost"}
        icon={<RefreshCw className="size-3.5" />}
        busy={diff.loading}
        onClick={diff.refresh}
      >
        {diff.loading ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Desktop inspector tab                                               */
/* ------------------------------------------------------------------ */

export function ChangesTab({ ctx, diff }: { ctx: SessionContext; diff: WorkspaceDiff }) {
  const review = useReviewComments(ctx.session.id);
  const counts = useCommentCounts(review.comments);
  const [selected, setSelected] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const files = diff.result?.files ?? [];

  if (!ctx.workspace || ctx.link !== "connected") {
    return (
      <div className="flex flex-col gap-3">
        <ChangesUnavailable ctx={ctx} />
        {(review.comments.length > 0 || ctx.task?.state === "review") && (
          <ReviewPanel ctx={ctx} review={review} />
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RefreshRow diff={diff} />
      {diff.error !== null && !diff.result ? (
        <ErrorState
          compact
          title="Could not load changes"
          error={diff.error}
          onRetry={diff.refresh}
        />
      ) : !diff.result ? (
        <LoadingState label="Loading changes…" />
      ) : files.length === 0 ? (
        <EmptyState
          icon={<FileDiff className="size-8" />}
          title="No changes yet"
          description={`Nothing differs from ${diff.result.base} in this workspace.`}
          className="py-6"
        />
      ) : (
        <>
          {diff.error !== null && (
            <ErrorState
              compact
              title="Refresh failed; showing earlier changes"
              error={diff.error}
              onRetry={diff.refresh}
            />
          )}
          <ChangedFileList
            files={files}
            selected={selected}
            onSelect={(p) => setSelected((cur) => (cur === p ? null : p))}
            commentCounts={counts}
          />
          {selected && (
            <FileDiffView
              ctx={ctx}
              diff={diff}
              path={selected}
              comments={review.comments}
              onComment={setCommentDraft}
            />
          )}
        </>
      )}
      {(review.comments.length > 0 || ctx.task?.state === "review") && (
        <ReviewPanel ctx={ctx} review={review} />
      )}
      <CommentForm
        draft={commentDraft}
        mobile={false}
        onClose={() => setCommentDraft(null)}
        onSave={(text) => {
          if (commentDraft) review.add({ ...commentDraft, text });
          setCommentDraft(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mobile: file list first, then a full-screen unified diff            */
/* ------------------------------------------------------------------ */

export function MobileChanges({ ctx }: { ctx: SessionContext }) {
  const diff = useWorkspaceDiff(ctx);
  const review = useReviewComments(ctx.session.id);
  const counts = useCommentCounts(review.comments);
  const [open, setOpen] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const files = diff.result?.files ?? [];
  const idx = open ? files.findIndex((f) => f.path === open) : -1;

  if (open && idx >= 0) {
    return (
      <FullScreenDiff
        ctx={ctx}
        diff={diff}
        file={files[idx]!}
        index={idx}
        total={files.length}
        comments={review.comments}
        onBack={() => setOpen(null)}
        onPrev={() => setOpen(files[idx - 1]?.path ?? open)}
        onNext={() => setOpen(files[idx + 1]?.path ?? open)}
        commentDraft={commentDraft}
        setCommentDraft={setCommentDraft}
        onSaveComment={(text) => {
          if (commentDraft) review.add({ ...commentDraft, text });
          setCommentDraft(null);
        }}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
      {!ctx.workspace || ctx.link !== "connected" ? (
        <ChangesUnavailable ctx={ctx} />
      ) : (
        <>
          <RefreshRow diff={diff} />
          {diff.error !== null && !diff.result ? (
            <ErrorState title="Could not load changes" error={diff.error} onRetry={diff.refresh} />
          ) : !diff.result ? (
            <LoadingState label="Loading changes…" />
          ) : files.length === 0 ? (
            <EmptyState
              icon={<FileDiff className="size-8" />}
              title="No changes yet"
              description={`Nothing differs from ${diff.result.base} in this workspace.`}
            />
          ) : (
            <ChangedFileList
              files={files}
              selected={null}
              onSelect={setOpen}
              commentCounts={counts}
              large
            />
          )}
        </>
      )}
      {(review.comments.length > 0 || ctx.task?.state === "review") && (
        <ReviewPanel ctx={ctx} review={review} />
      )}
    </div>
  );
}

function FullScreenDiff({
  ctx,
  diff,
  file,
  index,
  total,
  comments,
  onBack,
  onPrev,
  onNext,
  commentDraft,
  setCommentDraft,
  onSaveComment,
}: {
  ctx: SessionContext;
  diff: WorkspaceDiff;
  file: ChangedFile;
  index: number;
  total: number;
  comments: ReviewComment[];
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  commentDraft: CommentDraft | null;
  setCommentDraft: (d: CommentDraft | null) => void;
  onSaveComment: (text: string) => void;
}) {
  useHideBottomNav(true);
  const backRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the header when the file changes
  useEffect(() => backRef.current?.focus(), [file.path]);
  const mine = comments.filter((c) => c.file === file.path).length;
  return (
    <section
      aria-label={`Diff of ${file.path}`}
      className="fixed inset-0 z-40 flex min-w-0 flex-col bg-bg safe-pt safe-px"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !commentDraft) {
          e.preventDefault();
          onBack();
        }
      }}
    >
      <header className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
        <IconButton
          ref={backRef}
          label="Back to changed files"
          icon={<ArrowLeft className="size-4" />}
          onClick={onBack}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs" title={file.path}>
            {file.path}
          </div>
          <div className="text-xs text-muted">
            File {index + 1} of {total} · +{file.added} -{file.deleted}
            {mine > 0 && ` · ${mine} comment${mine === 1 ? "" : "s"}`}
          </div>
        </div>
        <IconButton
          label="Previous file"
          icon={<ChevronLeft className="size-4" />}
          disabled={index === 0}
          onClick={onPrev}
        />
        <IconButton
          label="Next file"
          icon={<ChevronRight className="size-4" />}
          disabled={index >= total - 1}
          onClick={onNext}
        />
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 safe-pb-2">
        <p className="mb-2 text-xs text-muted">Tap a line to add a review comment.</p>
        <FileDiffView
          ctx={ctx}
          diff={diff}
          path={file.path}
          comments={comments}
          onComment={setCommentDraft}
        />
      </div>
      <CommentForm
        draft={commentDraft}
        mobile
        onClose={() => setCommentDraft(null)}
        onSave={onSaveComment}
      />
    </section>
  );
}
