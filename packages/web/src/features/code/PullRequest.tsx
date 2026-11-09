import type { GitHubLogs } from "@switchyard/protocol";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/intent/Markdown";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { errorMessage, isApiError } from "../../sync/api";
import { codeApi } from "./api";
import {
  cleanGitHubText,
  failingCiPrompt,
  githubFresh,
  githubStatus,
  mergeBlockReason,
  reviewCommentsPrompt,
  verifiedPullRequestNodeId,
} from "./githubLogic";
import { type SessionContext, useNow } from "./hooks";
import { composerBlockReason, isBusy, sendModes } from "./model";
import type { PullRequestState } from "./usePullRequest";

function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a
      className="text-accent underline break-words"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

/** Always visible in Details/Task, including before a conditional PR tab exists. */
export function GitHubStatus({
  ctx,
  state,
  onOpen,
  onRefresh,
}: {
  ctx: SessionContext;
  state: PullRequestState;
  onOpen?: () => void;
  onRefresh?: () => Promise<void>;
}) {
  return (
    <section aria-label="GitHub" className="flex flex-col gap-2 text-sm">
      <h3 className="font-semibold">GitHub</h3>
      <p>
        {ctx.workspace
          ? githubStatus(state.snapshot, state.github?.available ?? null)
          : "No workspace linked to this session."}
      </p>
      {state.github?.reason && <p className="text-warning">{state.github.reason}</p>}
      {state.snapshot && (
        <p className="text-xs text-muted">
          {state.snapshot.fetchedAt
            ? `Fetched ${formatRelative(state.snapshot.fetchedAt)}`
            : "Never successfully fetched"}
          {state.error || ctx.link !== "connected" || !githubFresh(state.snapshot, Date.now())
            ? " · Stale"
            : ""}
          {ctx.link !== "connected" ? " · Host offline" : ""}
          {` · Attempted ${formatRelative(state.snapshot.attemptedAt)}`}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-danger">
          {state.error} Showing cached data, if available.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          busy={state.loading}
          disabled={!ctx.workspace || !!ctx.workspace.archivedAt || ctx.link !== "connected"}
          onClick={() => void (onRefresh ? onRefresh() : state.refresh())}
        >
          Refresh
        </Button>
        {state.snapshot?.pullRequest && onOpen && (
          <Button size="sm" onClick={onOpen}>
            Open PR
          </Button>
        )}
      </div>
    </section>
  );
}

type Confirmation = {
  workspaceId: string;
  repository: string;
  number: number;
  sha: string;
  nodeId: string;
};

export function PullRequest({
  ctx,
  state,
  active,
}: {
  ctx: SessionContext;
  state: PullRequestState;
  active: boolean;
}) {
  const { snapshot, github } = state;
  const pr = snapshot?.pullRequest;
  const nodeId = verifiedPullRequestNodeId(pr ?? null);
  const now = useNow(active && state.pageVisible);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState<"ci" | "review" | "merge" | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<GitHubLogs | null>(null);
  const identity = `${ctx.workspace?.id}:${snapshot?.repository}:${pr?.number}:${pr?.headRefOid}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  // A confirmation is an immutable reviewed identity, never an alias of the current head.
  useEffect(() => {
    if (
      !active ||
      (confirmation &&
        (confirmation.workspaceId !== ctx.workspace?.id ||
          confirmation.repository !== snapshot?.repository ||
          confirmation.number !== pr?.number ||
          confirmation.sha !== pr?.headRefOid ||
          confirmation.nodeId !== nodeId))
    )
      setConfirmation(null);
  }, [
    active,
    confirmation,
    ctx.workspace?.id,
    snapshot?.repository,
    pr?.number,
    pr?.headRefOid,
    nodeId,
  ]);
  // Do not keep another head's logs/errors when a workspace or PR changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on verified identity change
  useEffect(() => {
    setLogs(null);
    setError(null);
  }, [identity]);

  const dataBlock =
    ctx.link !== "connected"
      ? "Host is offline."
      : ctx.session.readOnly
        ? "This session is view only."
        : ctx.session.archivedAt || ctx.workspace?.archivedAt
          ? "Archived sessions/workspaces cannot perform PR actions."
          : !github?.available
            ? (github?.reason ?? "GitHub integration is unsupported on this host.")
            : state.loading
              ? "Refreshing PR data."
              : state.error
                ? "Refresh required after the last request failed."
                : !githubFresh(snapshot, now)
                  ? "Refresh required: PR data is stale or unavailable."
                  : !snapshot?.checksComplete || !snapshot.threadsComplete || snapshot.truncated
                    ? "PR data is incomplete. Refresh before performing actions."
                    : snapshot?.branch !== ctx.workspace?.branch
                      ? "Workspace branch changed. Refresh the PR association."
                      : null;
  const mergeBlock = state.mergeUncertain
    ? "Merge outcome unknown. Refresh before retrying."
    : (dataBlock ?? mergeBlockReason(snapshot, now));
  const modes = sendModes(ctx.session, ctx.host?.capabilities);
  const sendBlock =
    dataBlock ??
    composerBlockReason({ session: ctx.session, hostLink: ctx.link, hostName: ctx.hostName })
      ?.reason ??
    (isBusy(ctx.session) && !modes.followUp ? "This runtime cannot queue follow-ups." : null);
  const sendBlockRef = useRef(sendBlock);
  sendBlockRef.current = sendBlock;
  const failed = snapshot?.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");

  const refresh = async () => {
    if (inFlight.current) return;
    const value = await state.refresh();
    if (value?.snapshot?.status === "ready") {
      setError(null);
    }
  };
  const send = async (kind: "ci" | "review") => {
    if (sendBlock || busy || inFlight.current || !pr || !ctx.workspace || !snapshot) return;
    inFlight.current = true;
    setBusy(kind);
    setError(null);
    const requestedIdentity = identity;
    try {
      let text: string;
      if (kind === "ci") {
        const result = await codeApi.prFailedLogs(ctx.workspace.id, pr.headRefOid);
        if (identityRef.current !== requestedIdentity)
          throw new Error("PR head changed. Refresh and send again.");
        if (
          result.headOid !== pr.headRefOid ||
          result.repository.toLowerCase() !== snapshot.repository?.toLowerCase() ||
          result.number !== pr.number
        )
          throw new Error("CI logs do not match the displayed PR head. Refresh required.");
        setLogs(result);
        if (result.status !== "ready" || !result.jobs.some((j) => j.status === "available"))
          throw new Error(
            result.reason ?? "No failed-job logs are available. See job reasons below.",
          );
        text = failingCiPrompt(result);
      } else text = reviewCommentsPrompt(snapshot);
      if (sendBlockRef.current) throw new Error(sendBlockRef.current);
      const current = ctxRef.current;
      const blocked = composerBlockReason({
        session: current.session,
        hostLink: current.link,
        hostName: current.hostName,
      });
      if (blocked) throw new Error(blocked.reason);
      if (identityRef.current !== requestedIdentity)
        throw new Error("PR head changed. Refresh and send again.");
      if (
        isBusy(current.session) &&
        !sendModes(current.session, current.host?.capabilities).followUp
      )
        throw new Error("This runtime cannot queue follow-ups.");
      const result = await codeApi.prompt(current.session.id, {
        text,
        mode: isBusy(current.session) ? "followUp" : "prompt",
      });
      if (!result.ok) throw new Error("The prompt was not accepted.");
      toast.success(
        kind === "ci" ? "Failing CI sent to the agent." : "Review comments sent to the agent.",
      );
    } catch (e) {
      if (identityRef.current === requestedIdentity) setError(errorMessage(e));
      if (isApiError(e, "conflict")) {
        setConfirmation(null);
        void state.reload();
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const merge = async () => {
    if (
      !confirmation ||
      mergeBlock ||
      busy ||
      inFlight.current ||
      confirmation.sha !== pr?.headRefOid ||
      confirmation.workspaceId !== ctx.workspace?.id ||
      confirmation.repository !== snapshot?.repository ||
      confirmation.number !== pr?.number ||
      confirmation.nodeId !== nodeId
    )
      return;
    const reviewed = confirmation;
    inFlight.current = true;
    setBusy("merge");
    setError(null);
    try {
      const result = await codeApi.prMerge(reviewed.workspaceId, reviewed.sha);
      setConfirmation(null);
      if (result.status === "outcome_unknown") {
        state.markMergeUncertain();
        setError(`${result.reason} Refresh before retrying.`);
      } else {
        toast.success("Pull request squash merged. Task acceptance is unchanged.");
        void state.reload();
      }
    } catch (e) {
      setConfirmation(null);
      setError(errorMessage(e));
      if (isApiError(e, "conflict")) void state.reload();
      else state.markMergeUncertain(); // Never automatically retry a possibly applied mutation.
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Pull request">
      <GitHubStatus ctx={ctx} state={state} onRefresh={refresh} />
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      {pr && snapshot && (
        <>
          <h3 className="text-sm font-semibold">
            <ExternalLink url={pr.url}>
              #{pr.number} {cleanGitHubText(pr.title)}
            </ExternalLink>
          </h3>
          <p className="text-xs break-words">
            {pr.state}
            {pr.isDraft ? " · Draft" : ""} · {pr.mergeable} · {pr.mergeStateStatus} ·{" "}
            {pr.reviewDecision ?? "No review decision"}
          </p>
          <p className="text-xs break-words">
            {pr.headRepository ?? "Unknown head repository"} · {pr.headRefName} → {pr.baseRefName}
          </p>
          <p className="text-xs break-all">
            Head SHA: <code>{pr.headRefOid}</code>
          </p>
          {(!snapshot.checksComplete || !snapshot.threadsComplete || snapshot.truncated) && (
            <p className="text-sm text-warning">
              Partial data: {!snapshot.checksComplete ? "checks incomplete. " : ""}
              {!snapshot.threadsComplete ? "review threads incomplete. " : ""}
              {snapshot.truncated ? "Results truncated." : ""}
            </p>
          )}
          <section aria-label="Checks" className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Checks</h4>
            {!snapshot.checks.length && (
              <p className="text-sm text-muted">
                {snapshot.checksComplete
                  ? "No checks reported."
                  : "Checks are unavailable, not confirmed empty."}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {snapshot.checks.map((c) => (
                <li key={c.id} className="text-sm break-words">
                  {c.link ? (
                    <ExternalLink url={c.link}>{cleanGitHubText(c.name)}</ExternalLink>
                  ) : (
                    cleanGitHubText(c.name)
                  )}{" "}
                  · {c.bucket} ({cleanGitHubText(c.state)})
                  {c.workflow && (
                    <p className="text-xs text-muted">
                      {cleanGitHubText(c.workflow)}
                      {c.event ? ` · ${cleanGitHubText(c.event)}` : ""}
                    </p>
                  )}
                  {c.description && (
                    <p className="text-xs text-muted">{cleanGitHubText(c.description)}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Open review threads" className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Open review threads</h4>
            {!snapshot.threads.length && (
              <p className="text-sm text-muted">
                {snapshot.threadsComplete
                  ? "No unresolved review threads."
                  : "Review threads are unavailable, not confirmed empty."}
              </p>
            )}
            {snapshot.threads.map((t) => (
              <article key={t.id} className="rounded border border-border p-2 text-sm">
                <p className="break-words font-mono text-xs">
                  {cleanGitHubText(t.path ?? "Unknown file")}
                  {t.line ? `:${t.startLine ? `${t.startLine}–` : ""}${t.line}` : ""}
                  {t.side ? ` (${t.side})` : ""}
                  {t.isOutdated ? " · Outdated" : ""}
                </p>
                {t.comments.map((c) => (
                  <div key={c.id} className="mt-2">
                    <ExternalLink url={c.url}>
                      {cleanGitHubText(c.author ?? "Unknown author")}
                    </ExternalLink>
                    <Markdown text={cleanGitHubText(c.body)} />
                    {c.bodyTruncated && <p className="text-warning text-xs">Comment truncated.</p>}
                  </div>
                ))}
                {!t.commentsComplete && (
                  <p className="text-warning text-xs">Thread comments incomplete.</p>
                )}
              </article>
            ))}
          </section>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!!sendBlock || !failed || !!busy}
              title={sendBlock ?? undefined}
              busy={busy === "ci"}
              onClick={() => void send("ci")}
            >
              Send failing CI to the agent
            </Button>
            <Button
              disabled={!!sendBlock || !snapshot.threads.length || !!busy}
              title={sendBlock ?? undefined}
              busy={busy === "review"}
              onClick={() => void send("review")}
            >
              Resolve review comments
            </Button>
            <Button
              disabled={!!mergeBlock || !!busy}
              title={mergeBlock ?? undefined}
              onClick={() =>
                setConfirmation({
                  workspaceId: ctx.workspace!.id,
                  repository: snapshot.repository!,
                  number: pr.number,
                  sha: pr.headRefOid,
                  nodeId: nodeId!,
                })
              }
            >
              Squash merge
            </Button>
          </div>
          {sendBlock && <p className="text-xs text-muted">Agent prompts: {sendBlock}</p>}
          {mergeBlock && <p className="text-xs text-muted">Merge: {mergeBlock}</p>}
          <p className="text-xs text-muted">
            Sending comments asks the agent to change code, not resolve GitHub threads or commit.
            Merging never accepts the task or deletes the branch.
          </p>
        </>
      )}
      {logs && (
        <section aria-label="Failed CI logs" className="flex flex-col gap-2 text-sm">
          <h4 className="font-semibold">Failed CI logs</h4>
          <p>
            {logs.complete ? "All selected failed jobs retrieved." : "Incomplete job coverage."}
            {logs.truncated ? " Truncated log tails." : ""} Omitted jobs:{" "}
            {logs.omittedJobs ?? "unknown"}.
          </p>
          {logs.jobs.map((j) => (
            <details key={j.checkId}>
              <summary>
                {cleanGitHubText(j.name)} · {j.status}
                {j.truncated ? " · truncated" : ""}
              </summary>
              {j.outputTail !== null ? (
                <pre className="overflow-x-auto text-xs">{cleanGitHubText(j.outputTail)}</pre>
              ) : (
                <p>{j.reason}</p>
              )}
            </details>
          ))}
        </section>
      )}
      <ConfirmDialog
        open={!!confirmation && active}
        onClose={() => !busy && setConfirmation(null)}
        title="Squash merge pull request?"
        description={
          <span>
            Merge {confirmation?.repository} #{confirmation?.number} at the reviewed head SHA{" "}
            <code className="break-all">{confirmation?.sha}</code>. GitHub protections still apply.
            The task will not be accepted.
          </span>
        }
        confirmLabel="Squash merge"
        onConfirm={() => void merge()}
        busy={busy === "merge"}
        confirmDisabled={!!mergeBlock || !!busy}
        disabledReason={mergeBlock}
      />
    </section>
  );
}
