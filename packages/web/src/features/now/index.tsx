import type { Eligibility, Priority, Task } from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";
import {
  CalendarClock,
  CircleCheck,
  CirclePause,
  ExternalLink,
  FolderLock,
  Gauge,
  Inbox,
  Link2,
  LoaderCircle,
  type LucideIcon,
  PowerOff,
  RotateCw,
  Timer,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes";
import { buttonClasses } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { StatusChip } from "../../components/ui/StatusChip";
import {
  EmptyState,
  ErrorState,
  FatalError,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { errorMessage, isApiError } from "../../sync/api";
import { useConnection, useSyncStore } from "../../sync/store";
import { updateTask } from "../board/api";
import { DispatchToggle } from "../board/BoardChrome";
import { isRunActive, WAIT_LABELS, type WaitReason } from "../board/logic";
import { useNow } from "./useNow";

const WAIT_ICONS: Record<WaitReason, LucideIcon> = {
  dependency: Link2,
  host_offline: WifiOff,
  project_limit: Gauge,
  workspace_occupied: FolderLock,
  scheduled_time: CalendarClock,
  invalid_configuration: TriangleAlert,
  dispatch_paused: CirclePause,
  project_automation_disabled: PowerOff,
  not_ready: Inbox,
  already_dispatched: LoaderCircle,
  retry_backoff: RotateCw,
};

/** /now: running and queued work, each queued row explaining its wait. */
export default function NowView() {
  const now = useNow();
  const tasks = useSyncStore((s) => s.tasks);
  const runs = useSyncStore((s) => s.runs);
  const hydrated = useSyncStore((s) => s.hydrated);
  const connection = useConnection();
  const unsupported = isApiError(now.error) && now.error.status === 404;
  const malformed =
    !!now.data && (!Array.isArray(now.data.running) || !Array.isArray(now.data.queued));

  // Running from the server, or from the store when the endpoint is unavailable.
  const running = useMemo(() => {
    if (now.data && !malformed)
      return now.data.running.map((r) => ({
        taskId: r.taskId,
        runId: r.runId,
        sessionId: r.sessionId,
      }));
    return Object.values(runs)
      .filter((r) => isRunActive(r) && r.state !== "queued")
      .map((r) => ({ taskId: r.taskId, runId: r.id, sessionId: r.sessionId }));
  }, [now.data, runs, malformed]);
  const queued = useMemo(() => {
    if (now.data && !malformed)
      return now.data.queued.map((q) => ({
        taskId: q.taskId,
        eligibility: q.eligibility as Eligibility | undefined,
      }));
    return Object.values(tasks)
      .filter((t) => t.state === "ready" && !t.hiddenFromBoard)
      .sort((a, b) => a.priority - b.priority || a.position - b.position)
      .map((t) => ({ taskId: t.id, eligibility: undefined as Eligibility | undefined }));
  }, [now.data, tasks, malformed]);

  const loading = (!now.data && now.loading && !now.error) || !hydrated;
  const fatal = !!now.error && !unsupported && !now.data;
  if (malformed)
    return (
      <FatalError
        title="The coordinator sent a queue this version cannot read"
        error="GET /api/now returned an unexpected shape. Check that the web app and coordinator versions match."
      />
    );

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-4 py-4 safe-pt md:px-6">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">Now</h1>
        <DispatchToggle />
      </header>
      <p className="text-sm text-muted">
        Pausing stops new work from starting. Runs already in progress keep going.
      </p>
      {connection.state !== "live" && now.data && (
        <p role="status" className="text-sm text-muted">
          Showing the last known queue.
        </p>
      )}
      {unsupported && (
        <UnsupportedCapability
          capability="Queue explanations"
          reason="This coordinator does not report why queued tasks are waiting. The list below comes from local data."
        />
      )}
      {now.error != null && !unsupported && (
        <ErrorState
          compact
          title="Could not refresh running and queued work"
          error={errorMessage(now.error)}
          onRetry={now.reload}
        />
      )}

      {loading ? (
        <LoadingState label="Loading running and queued work…" />
      ) : fatal && running.length === 0 && queued.length === 0 ? null : running.length === 0 &&
        queued.length === 0 ? (
        <EmptyState
          icon={<Timer className="size-8" />}
          title="Nothing running or queued"
          description="Move a task to Ready on the board and the dispatcher starts it when it is eligible."
          action={{ label: "Go to Board", to: ROUTES.board }}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
          <section aria-labelledby="now-running" className="flex min-w-0 flex-col gap-2">
            <h2 id="now-running" className="text-base font-semibold">
              Running <span className="text-sm font-normal text-muted">({running.length})</span>
            </h2>
            {running.length === 0 ? (
              <p className="text-sm text-muted">Nothing is running.</p>
            ) : (
              <ul className="flex min-w-0 flex-col gap-2">
                {running.map((r) => (
                  <li key={r.runId}>
                    <RunningRow taskId={r.taskId} runId={r.runId} sessionId={r.sessionId} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="now-queued" className="flex min-w-0 flex-col gap-2">
            <h2 id="now-queued" className="text-base font-semibold">
              Queued <span className="text-sm font-normal text-muted">({queued.length})</span>
            </h2>
            {queued.length === 0 ? (
              <p className="text-sm text-muted">No Ready tasks are waiting.</p>
            ) : (
              <ul className="flex min-w-0 flex-col gap-2">
                {queued.map((q) => (
                  <li key={q.taskId}>
                    <QueuedRow
                      task={tasks[q.taskId]}
                      taskId={q.taskId}
                      eligibility={q.eligibility}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function RunningRow({
  taskId,
  runId,
  sessionId,
}: {
  taskId: string;
  runId: string;
  sessionId: string | null;
}) {
  const task = useSyncStore((s) => s.tasks[taskId]);
  const run = useSyncStore((s) => s.runs[runId]);
  const host = useSyncStore((s) => (run?.hostId ? s.hosts[run.hostId] : undefined));
  const project = useSyncStore((s) => (task ? s.projects[task.projectId] : undefined));
  const offline = !!host && host.connectivity !== "connected";
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {run ? (
          <StatusChip kind="run" value={run.state} size="sm" />
        ) : (
          <StatusChip kind="task" value="in_progress" size="sm" />
        )}
        <Link
          to={ROUTES.task(taskId)}
          className="min-w-0 flex-1 basis-48 font-medium break-words hover:underline"
        >
          {task?.title ?? "Task"}
        </Link>
        {(sessionId ?? task?.sessionId) && (
          <Link
            to={ROUTES.session((sessionId ?? task?.sessionId) as string)}
            className={buttonClasses("secondary", "sm")}
          >
            <ExternalLink aria-hidden className="size-3.5" />
            Open session
          </Link>
        )}
      </div>
      <p className="text-xs text-muted">
        {[
          project?.name,
          host ? `on ${host.name}` : null,
          run?.attempt && run.attempt > 1 ? `attempt ${run.attempt}` : null,
          run?.startedAt ? `started ${formatRelative(run.startedAt)}` : null,
          run?.controlMode === "human" ? "you have control" : "automation",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {run?.state === "uncertain" && host && (
        <p className="text-sm text-warning">
          <span className="text-text">
            Waiting for host {host.name} to confirm launch. It is never started elsewhere.
          </span>
        </p>
      )}
      {offline && host && (
        <HostUnavailable
          compact
          hostName={host.name}
          connectivity={host.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
          lastSeenAt={host.lastSeenAt}
        />
      )}
    </article>
  );
}

function QueuedRow({
  task,
  taskId,
  eligibility,
}: {
  task: Task | undefined;
  taskId: string;
  eligibility?: Eligibility;
}) {
  const project = useSyncStore((s) => (task ? s.projects[task.projectId] : undefined));
  const [busy, setBusy] = useState(false);
  const id = useId();
  const Icon = eligibility
    ? eligibility.eligible
      ? CircleCheck
      : WAIT_ICONS[eligibility.wait]
    : Timer;
  const waitLabel = eligibility
    ? eligibility.eligible
      ? `Starting on ${eligibility.hostName}`
      : WAIT_LABELS[eligibility.wait]
    : "Waiting for dispatch";
  const detail = eligibility && !eligibility.eligible ? eligibility.message : null;
  return (
    <article
      data-testid="now-queued-row"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={ROUTES.task(taskId)} className="min-w-0 font-medium break-words hover:underline">
          {task?.title ?? "Task"}
        </Link>
        {project && <span className="text-xs text-muted">{project.name}</span>}
        <p className="flex min-w-0 items-start gap-1.5 text-sm">
          <Icon
            aria-hidden
            className={`mt-0.5 size-4 shrink-0 ${eligibility?.eligible ? "text-success" : "text-warning"}`}
          />
          <span className="min-w-0 break-words">
            <span className="font-medium">{waitLabel}</span>
            {detail && detail !== waitLabel ? <span className="text-muted">: {detail}</span> : null}
          </span>
        </p>
      </div>
      {task && (
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor={id} className="text-sm text-muted">
            Priority
          </label>
          <select
            id={id}
            value={task.priority}
            disabled={busy}
            className="tap h-9 rounded-md border border-border bg-surface px-2 text-base md:text-sm"
            onChange={async (e) => {
              const p = Number(e.target.value) as Priority;
              setBusy(true);
              try {
                await updateTask(task.id, { priority: p });
                toast.success(`"${task.title}" is now ${PRIORITY_LABELS[p]} priority`);
              } catch (err) {
                toast.error(`Could not change priority: ${errorMessage(err)}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            {PRIORITY_LABELS.map((l, i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </select>
          {busy && <Spinner label="Saving priority" />}
        </div>
      )}
    </article>
  );
}
