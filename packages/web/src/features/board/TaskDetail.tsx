import type { Eligibility, Priority, Run, Task } from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  Eye,
  MessageSquareWarning,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ROUTES } from "../../app/routes";
import { Markdown } from "../../components/intent/Markdown";
import { Button, buttonClasses } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { StatusChip } from "../../components/ui/StatusChip";
import {
  ErrorState,
  HostUnavailable,
  InteractionPending,
  UnsupportedCapability,
} from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatDuration, formatRelative, formatTime } from "../../lib/time";
import { errorMessage, isApiError } from "../../sync/api";
import { runsForTask, useSyncStore } from "../../sync/store";
import {
  deleteTask,
  fetchEligibility,
  fetchRuns,
  requestChanges,
  taskAction,
  updateTask,
} from "./api";
import { eligibilityText, isRunActive, previewEligibility, STATE_LABELS } from "./logic";
import { useTaskMover } from "./MoveProvider";
import { executionLine, PRIORITY_INFO, useTaskInfo } from "./taskInfo";
import { useResource } from "./useResource";

const ACCEPT_NOTE = "Accepting marks the task Done. It does not merge or push.";

export function reviewChangesHref(task: Task): string | null {
  return task.sessionId ? `${ROUTES.session(task.sessionId)}?tab=changes` : null;
}

/** Eligibility for the drawer: the coordinator's answer, or a client estimate for Backlog tasks. */
export function useEligibility(task: Task | undefined) {
  const relevant = !!task && (task.state === "ready" || task.state === "backlog");
  const key = relevant ? `${task.id}:${task.state}:${task.updatedAt}` : null;
  const res = useResource<Eligibility>(key, (signal) => fetchEligibility(task!.id, signal));
  const hosts = useSyncStore((s) => s.hosts);
  const tasks = useSyncStore((s) => s.tasks);
  const projects = useSyncStore((s) => s.projects);
  const runs = useSyncStore((s) => s.runs);
  const paused = useSyncStore((s) => s.dispatchPaused);
  const estimate = useMemo(() => {
    if (!task) return undefined;
    const runningByProject: Record<string, number> = {};
    for (const r of Object.values(runs)) {
      if (!isRunActive(r)) continue;
      const p = tasks[r.taskId]?.projectId;
      if (p) runningByProject[p] = (runningByProject[p] ?? 0) + 1;
    }
    return previewEligibility(
      {
        project: projects[task.projectId],
        hostId: task.policy.hostId,
        dependencies: task.dependencies,
        notBefore: task.notBefore,
      },
      { hosts, tasks, dispatchPaused: paused, runningByProject },
    );
  }, [task, hosts, tasks, projects, runs, paused]);
  const server = res.data;
  let value: Eligibility | undefined;
  if (!relevant) value = undefined;
  else if (server) value = !server.eligible && server.wait === "not_ready" ? estimate : server;
  else if (res.error) value = estimate;
  return {
    eligibility: value,
    loading: res.loading && !res.data,
    error: res.error,
    estimated: !!value && value === estimate,
  };
}

/* ------------------------------------------------------------------ */

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2 border-b border-border py-4 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <h3 id={id} className="min-w-0 flex-1 text-sm font-semibold">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** The state-dependent primary action (spec 13). */
export function PrimaryAction({
  task,
  eligibility,
  block,
}: {
  task: Task;
  eligibility?: Eligibility;
  block?: boolean;
}) {
  const mover = useTaskMover();
  const busy = mover.isBusy(task.id);
  const [reopening, setReopening] = useState(false);
  const wait = eligibility ? (
    <EligibilityNote e={eligibility} prefix={task.state === "backlog" ? "If made ready: " : ""} />
  ) : null;
  switch (task.state) {
    case "backlog":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <Button
            variant="primary"
            block={block}
            busy={busy}
            icon={<Play className="size-4" />}
            onClick={() => void mover.move(task, "ready")}
          >
            Make ready
          </Button>
          {wait}
        </div>
      );
    case "ready":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <Button
            variant="primary"
            block={block}
            busy={busy}
            icon={<Play className="size-4" />}
            onClick={() => void mover.runNow(task)}
          >
            Run now
          </Button>
          {wait}
        </div>
      );
    case "in_progress":
      return task.sessionId ? (
        <Link
          to={ROUTES.session(task.sessionId)}
          className={buttonClasses("primary", "md", block ? "w-full" : undefined)}
        >
          <ExternalLink aria-hidden className="size-4" />
          Open session
        </Link>
      ) : (
        <p className="text-sm text-muted">
          {task.blocked
            ? "No session is attached to this task."
            : "The session is starting; Open session appears once the host confirms the launch."}
        </p>
      );
    case "review": {
      const href = reviewChangesHref(task);
      return href ? (
        <Link to={href} className={buttonClasses("primary", "md", block ? "w-full" : undefined)}>
          <Eye aria-hidden className="size-4" />
          Review changes
        </Link>
      ) : (
        <a
          href="#task-review"
          className={buttonClasses("primary", "md", block ? "w-full" : undefined)}
        >
          <Eye aria-hidden className="size-4" />
          Review changes
        </a>
      );
    }
    case "done":
      return (
        <Button
          variant="primary"
          block={block}
          busy={reopening}
          icon={<RotateCcw className="size-4" />}
          onClick={async () => {
            setReopening(true);
            try {
              await taskAction(task.id, "reopen");
              toast.success(`Reopened "${task.title}"`);
            } catch (e) {
              toast.error(`Could not reopen: ${errorMessage(e)}`);
            } finally {
              setReopening(false);
            }
          }}
        >
          Reopen
        </Button>
      );
    case "canceled":
      return (
        <Button
          variant="primary"
          block={block}
          busy={busy}
          icon={<RotateCcw className="size-4" />}
          onClick={() => void mover.move(task, "backlog")}
        >
          Restore to Backlog
        </Button>
      );
  }
}

export function EligibilityNote({ e, prefix = "" }: { e: Eligibility; prefix?: string }) {
  const Icon = e.eligible ? CircleCheck : Clock;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-1.5 text-sm",
        e.eligible ? "text-success" : "text-warning",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words text-text">
        {prefix}
        {eligibilityText(e)}
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */

/** All task drawer / detail sections (spec 13 task drawer, spec 14 detail). */
export function TaskDetailBody({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  const info = useTaskInfo(task);
  const { eligibility, error: eligibilityError } = useEligibility(task);
  const tasks = useSyncStore((s) => s.tasks);
  const hosts = useSyncStore((s) => s.hosts);
  const profiles = useSyncStore((s) => s.profiles);
  const projects = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const storeRuns = useSyncStore((s) => s.runs);
  const runsRes = useResource<Run[]>(`${task.id}:${task.currentRunId ?? ""}`, (signal) =>
    fetchRuns(task.id, signal),
  );
  const runs = useMemo(() => {
    const merged = new Map<string, Run>();
    for (const r of runsRes.data ?? []) merged.set(r.id, r);
    for (const r of runsForTask(storeRuns, task.id)) {
      const prev = merged.get(r.id);
      if (!prev || prev.updatedAt <= r.updatedAt) merged.set(r.id, r);
    }
    return [...merged.values()].sort(
      (a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt),
    );
  }, [runsRes.data, storeRuns, task.id]);
  const [editing, setEditing] = useState(false);
  const project = projects[task.projectId];
  const run = info.run;
  const exec = executionLine(task, run, eligibility);
  const hostId = task.policy.hostId ?? project?.defaultHostId ?? null;
  const host = hostId ? hosts[hostId] : undefined;
  const runHost = run?.hostId ? hosts[run.hostId] : undefined;
  const offlineHost = runHost && runHost.connectivity !== "connected" ? runHost : undefined;
  const pr = PRIORITY_INFO[task.priority];
  const PrIcon = pr.icon;
  const profileId = task.policy.profileId ?? project?.defaultProfileId ?? null;
  const pendingCount = useSyncStore((s) =>
    task.sessionId
      ? Object.values(s.interactions).filter(
          (i) => i.sessionId === task.sessionId && i.state === "pending",
        ).length
      : 0,
  );

  return (
    <div className="flex min-w-0 flex-col" data-testid="task-detail">
      {pendingCount > 0 && task.sessionId && info.pendingInteraction && (
        <InteractionPending
          count={pendingCount}
          to={ROUTES.interaction(task.sessionId, info.pendingInteraction.id)}
          className="mt-3"
        />
      )}
      {offlineHost && (
        <HostUnavailable
          compact
          className="mt-3"
          hostName={offlineHost.name}
          connectivity={
            offlineHost.connectivity === "reconnecting" ? "reconnecting" : "unreachable"
          }
          lastSeenAt={offlineHost.lastSeenAt}
          detail="The run keeps its last known state. Switchyard does not restart it on another host."
        />
      )}

      <Section
        title="Objective and acceptance criteria"
        action={
          !editing && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil className="size-3.5" />}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          <EditTaskForm task={task} onDone={() => setEditing(false)} />
        ) : (
          <>
            {task.objective.trim() ? (
              <Markdown text={task.objective} />
            ) : (
              <p className="text-sm text-muted">
                No objective yet. Edit the task to describe what done looks like.
              </p>
            )}
            <h4 className="pt-1 text-xs font-semibold tracking-wide text-muted uppercase">
              Acceptance criteria
            </h4>
            {task.acceptanceCriteria.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {task.acceptanceCriteria.map((c) => (
                  <li key={c} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No acceptance criteria.</p>
            )}
          </>
        )}
      </Section>

      <Section title="State">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip kind="task" value={task.state} />
          <span className="inline-flex items-center gap-1 text-sm text-muted">
            <PrIcon aria-hidden className="size-4" />
            {pr.label} priority
          </span>
        </div>
        {task.blocked && (
          <p className="flex items-start gap-1.5 rounded-md bg-danger-soft px-3 py-2 text-sm">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <span className="min-w-0 break-words">
              <span className="font-medium">Blocked:</span> {task.blocked.reason}
            </span>
          </p>
        )}
        {exec && !task.blocked && !(task.state === "ready" && eligibility) && (
          <p className="text-sm text-muted">{exec.text}</p>
        )}
        {(task.state === "ready" || task.state === "backlog") && eligibility && (
          <EligibilityNote
            e={eligibility}
            prefix={task.state === "backlog" ? "If made ready: " : ""}
          />
        )}
        {eligibilityError !== null &&
          isApiError(eligibilityError) &&
          eligibilityError.status === 404 && (
            <p className="text-xs text-muted">
              Eligibility is estimated on this device; the coordinator did not report it.
            </p>
          )}
        {task.notBefore && (
          <p className="text-sm text-muted">Not before {formatTime(task.notBefore)}</p>
        )}
      </Section>

      <Section title="Current run">
        {run ? (
          <dl className="flex flex-col gap-1">
            <Field label="Status">
              <StatusChip kind="run" value={run.state} size="sm" />
            </Field>
            <Field label="Attempt">{run.attempt}</Field>
            <Field label="Control">
              {run.controlMode === "human" ? "You (automation paused)" : "Automation"}
            </Field>
            {runHost && <Field label="Host">{runHost.name}</Field>}
            {run.startedAt && <Field label="Started">{formatRelative(run.startedAt)}</Field>}
            <Field label="Continuations">{run.continuationsUsed}</Field>
            <Field label="Usage">
              {run.usage.accounting === "available"
                ? `${run.usage.tokens ?? 0} tokens${run.usage.costUsd !== null ? ` · $${run.usage.costUsd.toFixed(2)}` : ""}`
                : (run.usage.note ?? "Token/cost accounting not reported")}
            </Field>
            {run.outcome && <Field label="Outcome">{run.outcome.summary}</Field>}
          </dl>
        ) : (
          <p className="text-sm text-muted">No run yet.</p>
        )}
        {task.sessionId && (
          <div>
            <Link to={ROUTES.session(task.sessionId)} className={buttonClasses("secondary", "sm")}>
              <ExternalLink aria-hidden className="size-3.5" />
              Open session
            </Link>
          </div>
        )}
      </Section>

      {task.state === "review" && <ReviewPanel task={task} />}

      <Section title="Dependencies">
        {task.dependencies.length === 0 ? (
          <p className="text-sm text-muted">No dependencies.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.dependencies.map((id) => {
              const d = tasks[id];
              return (
                <li key={id} className="flex min-w-0 items-center gap-2 text-sm">
                  {d ? (
                    <>
                      <StatusChip kind="task" value={d.state} size="sm" />
                      <Link
                        to={ROUTES.task(id)}
                        className="min-w-0 truncate text-accent hover:underline"
                      >
                        {d.title}
                      </Link>
                    </>
                  ) : (
                    <span className="text-muted">A task that is no longer available</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Host, profile and workspace">
        <dl className="flex flex-col gap-1">
          <Field label="Project">{project?.name ?? "Unknown project"}</Field>
          <Field label="Host">
            {task.policy.hostId
              ? (host?.name ?? "Unknown host")
              : `Project default${host ? ` (${host.name})` : ""}`}
          </Field>
          <Field label="Profile">
            {task.policy.profileId
              ? (profiles[task.policy.profileId]?.name ?? "Unknown profile")
              : `Project default${profileId && profiles[profileId] ? ` (${profiles[profileId].name})` : ""}`}
          </Field>
          <Field label="Workspace">
            {task.policy.workspace.mode === "existing"
              ? `Existing: ${workspaces[task.policy.workspace.workspaceId]?.branch ?? workspaces[task.policy.workspace.workspaceId]?.path ?? "unknown workspace"}`
              : `New worktree${task.policy.workspace.branch ? ` on ${task.policy.workspace.branch}` : ""}${task.policy.workspace.base ? ` from ${task.policy.workspace.base}` : ""}`}
          </Field>
          {project && (
            <Field label="Sharing">
              {project.workspaceSharing === "single_writer" ? "Single writer" : "Shared"}
            </Field>
          )}
        </dl>
        {host && !host.piCompatible && (
          <UnsupportedCapability
            capability="Running on this host"
            reason={`Pi ${host.piVersion ?? "(unknown version)"} on ${host.name} is not compatible with Switchyard.`}
          />
        )}
      </Section>

      <Section title="Limits and completion">
        <dl className="flex flex-col gap-1">
          <Field label="Continuation">
            {task.policy.continuation.enabled
              ? `Up to ${task.policy.continuation.maxContinuations} continuations within ${task.policy.continuation.maxElapsedMinutes} min${
                  task.policy.continuation.maxTokens
                    ? `, ${task.policy.continuation.maxTokens} tokens`
                    : ""
                }${task.policy.continuation.maxCostUsd ? `, $${task.policy.continuation.maxCostUsd}` : ""}`
              : "Off"}
          </Field>
          <Field label="Checks">
            {task.policy.completion.checks === null
              ? `Project default${project?.checks.length ? ` (${project.checks.join(", ")})` : " (none)"}`
              : task.policy.completion.checks.length > 0
                ? task.policy.completion.checks.join(", ")
                : "None"}
          </Field>
          <Field label="Human review">
            {task.policy.completion.requireHumanReview ? "Required" : "Not required"}
          </Field>
        </dl>
        {run && run.checks.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {run.checks.map((c) => (
              <li key={c.command} className="flex min-w-0 items-start gap-1.5">
                {c.exitCode === 0 ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                )}
                <span className="min-w-0 break-all font-mono text-xs">{c.command}</span>
                <span className="shrink-0 text-xs text-muted">
                  {c.exitCode === 0 ? "Passed" : `Failed (${c.exitCode ?? "no exit code"})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Run history and activity">
        {runsRes.error !== null && !runsRes.data && runs.length === 0 && (
          <ErrorState
            compact
            title="Could not load run history"
            error={errorMessage(runsRes.error)}
            onRetry={runsRes.reload}
          />
        )}
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{runsRes.loading ? "Loading runs…" : "No runs yet."}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Attempt {r.attempt}</span>
                  <StatusChip kind="run" value={r.state} size="sm" />
                </div>
                {r.outcome && <p className="break-words text-muted">{r.outcome.summary}</p>}
                <p className="text-xs text-subtle">
                  {r.startedAt
                    ? `Started ${formatTime(r.startedAt)}`
                    : `Created ${formatTime(r.createdAt)}`}
                  {r.startedAt && r.endedAt
                    ? ` · ${formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt))}`
                    : ""}
                  {r.infraRetries > 0 ? ` · ${r.infraRetries} infrastructure retries` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
        {task.review.feedback.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">Review feedback</p>
            <ul className="list-disc pl-5 text-muted">
              {task.review.feedback.map((f) => (
                <li key={f} className="break-words">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-subtle">
          Created {formatTime(task.createdAt)} · last activity {formatRelative(task.lastActivityAt)}
          {task.origin.kind === "automation" ? " · created by an automation" : ""}
        </p>
      </Section>

      <DeleteTask task={task} onDeleted={onDeleted} />
    </div>
  );
}

function DeleteTask({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (task.state !== "backlog" && task.state !== "canceled" && task.state !== "done") return null;
  return (
    <div className="py-4">
      <Button
        variant="ghost"
        size="sm"
        icon={<Trash2 className="size-4" />}
        className="text-danger"
        onClick={() => setOpen(true)}
      >
        Delete task
      </Button>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Delete this task?"
        description={`"${task.title}" and its history are removed from the board. Sessions and workspaces are kept.`}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteTask(task.id);
                  toast.success(`Deleted "${task.title}"`);
                  setOpen(false);
                  onDeleted?.();
                } catch (e) {
                  toast.error(`Could not delete: ${errorMessage(e)}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete task
            </Button>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

const feedbackKey = (id: string) => `sy:feedback:${id}`;

/** Review controls: Review changes, Request changes with feedback, Accept, Start new attempt. */
export function ReviewPanel({ task }: { task: Task }) {
  const mover = useTaskMover();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState(
    () => sessionStorage.getItem(feedbackKey(task.id)) ?? "",
  );
  const [busy, setBusy] = useState<"changes" | null>(null);
  const fid = useId();
  useEffect(() => {
    if (feedback) sessionStorage.setItem(feedbackKey(task.id), feedback);
    else sessionStorage.removeItem(feedbackKey(task.id));
  }, [feedback, task.id]);
  const href = reviewChangesHref(task);
  const items = feedback
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  return (
    <section
      id="task-review"
      aria-labelledby={`${fid}-h`}
      className="flex min-w-0 flex-col gap-3 border-b border-border py-4"
    >
      <h3 id={`${fid}-h`} className="text-sm font-semibold">
        Review
      </h3>
      {href && (
        <div>
          <Button size="sm" icon={<Eye className="size-3.5" />} onClick={() => navigate(href)}>
            Review changes
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={fid} className="text-sm font-medium">
          Feedback for the next attempt
        </label>
        <TextArea
          id={fid}
          minRows={3}
          maxHeight="40vh"
          placeholder="One change per line"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<MessageSquareWarning className="size-4" />}
            busy={busy === "changes"}
            disabled={busy !== null || items.length === 0}
            onClick={async () => {
              setBusy("changes");
              try {
                await requestChanges(task.id, items);
                setFeedback("");
                toast.success("Changes requested. Start a new attempt when ready.");
              } catch (e) {
                toast.error(`Could not request changes: ${errorMessage(e)}`);
              } finally {
                setBusy(null);
              }
            }}
          >
            Request changes
          </Button>
          <Button
            icon={<RotateCcw className="size-4" />}
            busy={mover.isBusy(task.id)}
            disabled={busy !== null}
            onClick={() => void mover.newAttempt(task)}
          >
            Start new attempt
          </Button>
        </div>
        {items.length === 0 && (
          <p className="text-xs text-muted">
            Write at least one line of feedback to request changes.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Button
          variant="primary"
          icon={<CircleCheck className="size-4" />}
          busy={mover.isBusy(task.id)}
          disabled={busy !== null}
          onClick={() => void mover.accept(task)}
        >
          Accept task
        </Button>
        <p className="text-xs text-muted">{ACCEPT_NOTE}</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function EditTaskForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const tasks = useSyncStore((s) => s.tasks);
  const [title, setTitle] = useState(task.title);
  const [objective, setObjective] = useState(task.objective);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.join("\n"));
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [deps, setDeps] = useState<string[]>(task.dependencies);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const candidates = Object.values(tasks)
    .filter(
      (t) =>
        t.projectId === task.projectId &&
        t.id !== task.id &&
        t.state !== "canceled" &&
        !t.hiddenFromBoard,
    )
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) {
          setError("Title is required.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await updateTask(task.id, {
            title: title.trim(),
            objective,
            acceptanceCriteria: criteria
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            priority,
            dependencies: deps,
          });
          toast.success("Task saved");
          onDone();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-sm font-medium">
          Title
        </label>
        <TextInput
          id={`${id}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-obj`} className="text-sm font-medium">
          Objective
        </label>
        <TextArea
          id={`${id}-obj`}
          minRows={4}
          maxHeight="40vh"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-crit`} className="text-sm font-medium">
          Acceptance criteria (one per line)
        </label>
        <TextArea
          id={`${id}-crit`}
          minRows={2}
          maxHeight="30vh"
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
        />
      </div>
      <PrioritySelect id={`${id}-prio`} value={priority} onChange={setPriority} />
      <DependencyPicker candidates={candidates} value={deps} onChange={setDeps} />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          Save
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PrioritySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Priority;
  onChange: (p: Priority) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        Priority
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as Priority)}
        className="tap h-9 rounded-md border border-border bg-surface px-2 text-base md:text-sm"
      >
        {PRIORITY_LABELS.map((l, i) => (
          <option key={l} value={i}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DependencyPicker({
  candidates,
  value,
  onChange,
}: {
  candidates: Task[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const shown = candidates
    .filter((t) => value.includes(t.id) || t.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 50);
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="text-sm font-medium">Dependencies</legend>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted">No other tasks in this project.</p>
      ) : (
        <>
          <label htmlFor={id} className="sr-only">
            Filter tasks
          </label>
          <TextInput
            id={id}
            placeholder="Filter tasks"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
            {shown.map((t) => (
              <li key={t.id}>
                <label className="tap flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={value.includes(t.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted">{STATE_LABELS[t.state]}</span>
                </label>
              </li>
            ))}
          </ul>
          {value.length > 0 && (
            <p className="text-xs text-muted">
              {value.length} selected. The task waits until they are Done.
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
