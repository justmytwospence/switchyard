import { Automation, type Host, type Project, type Task } from "@switchyard/protocol";
import {
  CalendarClock,
  ChevronRight,
  Clock,
  Hand,
  Link2,
  type LucideIcon,
  Play,
  Plus,
  Webhook,
  WifiOff,
  Workflow,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { useBreakpoint } from "../../app/useBreakpoint";
import { Button, buttonClasses } from "../../components/ui/Button";
import { EmptyState, ErrorState, FatalError, LoadingState } from "../../components/ui/states";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { apiGet } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import {
  ConnectionNote,
  FailureCount,
  Switch,
  useLocalAutomations,
  useMergedAutomations,
  useRunNow,
  useToggleEnabled,
} from "./controls";
import { describeTrigger, formatAbsolute, modeLabel, type TriggerKind } from "./describe";

const NEW_PATH = "/automations/new";
const editPath = (id: string) => `/automations/${encodeURIComponent(id)}`;

const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {
  manual: Hand,
  once: Clock,
  cron: CalendarClock,
  webhook: Webhook,
  dependency: Link2,
};

type FetchState =
  | { status: "idle" | "loading" | "done" }
  | { status: "error"; error: unknown }
  | { status: "fatal"; error: unknown };

/** Automations list (spec 15): enabled state, trigger, next occurrence, last outcome, failures. */
export default function AutomationsView() {
  const hydrated = useSyncStore((s) => s.hydrated);
  const automations = useMergedAutomations();
  const projects = useSyncStore((s) => s.projects);
  const hosts = useSyncStore((s) => s.hosts);
  const tasks = useSyncStore((s) => s.tasks);
  const bp = useBreakpoint();
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });

  // REST fallback while the sync snapshot has not arrived (and for retry after a failure).
  const load = useCallback(async () => {
    setFetchState({ status: "loading" });
    try {
      const res = await apiGet<unknown>("/api/automations");
      const list = Array.isArray(res)
        ? res
        : res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)
          ? (res as { items: unknown[] }).items
          : null;
      const parsed = list ? Automation.array().safeParse(list) : null;
      if (!parsed?.success) {
        setFetchState({
          status: "fatal",
          error: new Error("The coordinator returned automations in an unexpected format."),
        });
        return;
      }
      useLocalAutomations.getState().putMany(parsed.data);
      setFetchState({ status: "done" });
    } catch (e) {
      setFetchState({ status: "error", error: e });
    }
  }, []);

  useEffect(() => {
    if (!hydrated) void load();
  }, [hydrated, load]);

  const rows = useMemo(
    () => Object.values(automations).sort((a, b) => a.name.localeCompare(b.name)),
    [automations],
  );

  const haveData = hydrated || fetchState.status === "done";

  let body: ReactNode;
  if (!haveData) {
    if (fetchState.status === "fatal") body = <FatalError error={fetchState.error} />;
    else if (fetchState.status === "error")
      body = (
        <ErrorState
          title="Could not load automations"
          error={fetchState.error}
          onRetry={() => void load()}
        />
      );
    else body = <LoadingState label="Loading automations…" />;
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={<Workflow className="size-8" />}
        title="No automations yet"
        description="Automations create tasks on a schedule, from a webhook, or when another task is done."
        action={{ label: "Create an automation", to: NEW_PATH, icon: <Plus className="size-4" /> }}
      />
    );
  } else {
    body = (
      <AutomationRows
        automations={rows}
        projects={projects}
        hosts={hosts}
        tasks={tasks}
        table={bp === "desktop"}
      />
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-4 py-4 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Automations</h1>
          <p className="text-sm text-muted">
            Scheduled, webhook and dependency automations. Routine successes stay in each
            automation's history.
          </p>
        </div>
        <Link to={NEW_PATH} state={BACK_STATE} className={buttonClasses("primary")}>
          <Plus aria-hidden className="size-4" />
          New automation
        </Link>
      </header>
      <ConnectionNote />
      {body}
    </div>
  );
}

const TABLE_COLS =
  "grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_5.5rem_minmax(0,1.2fr)_minmax(0,1.4fr)_7.5rem_7rem_auto] items-center gap-3";

function AutomationRows({
  automations,
  projects,
  hosts,
  tasks,
  table,
}: {
  automations: Automation[];
  projects: Record<string, Project>;
  hosts: Record<string, Host>;
  tasks: Record<string, Task>;
  table: boolean;
}) {
  const { busy: toggling, toggle } = useToggleEnabled();
  const { busy: running, run } = useRunNow();
  const taskTitle = useCallback((id: string) => tasks[id]?.title, [tasks]);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      {table && (
        <div
          aria-hidden
          className={cn(
            TABLE_COLS,
            "border-b border-border bg-surface-2 px-4 py-2 text-xs font-medium text-muted",
          )}
        >
          <span>Automation</span>
          <span>Project</span>
          <span>Mode</span>
          <span>Next occurrence</span>
          <span>Last outcome</span>
          <span>Failures</span>
          <span>Enabled</span>
          <span className="sr-only">Actions</span>
        </div>
      )}
      <ul data-testid="automations-list" className="divide-y divide-border">
        {automations.map((a) => {
          const project = projects[a.projectId];
          const hostId = a.hostId ?? project?.defaultHostId ?? null;
          const host = hostId ? hosts[hostId] : undefined;
          const props: RowProps = {
            automation: a,
            projectName: project?.name ?? "Unknown project",
            host,
            trigger: describeTrigger(a.trigger, { taskTitle }),
            toggling: !!toggling[a.id],
            running: !!running[a.id],
            onToggle: (next) => void toggle(a, next),
            onRun: () => void run(a),
          };
          return (
            <li key={a.id} data-testid="automation-row" data-automation-id={a.id}>
              {table ? <TableRow {...props} /> : <CardRow {...props} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface RowProps {
  automation: Automation;
  projectName: string;
  host: Host | undefined;
  trigger: string;
  toggling: boolean;
  running: boolean;
  onToggle: (next: boolean) => void;
  onRun: () => void;
}

function TriggerText({ automation, trigger }: { automation: Automation; trigger: string }) {
  const Icon = TRIGGER_ICONS[automation.trigger.kind];
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-sm text-muted">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{trigger}</span>
    </span>
  );
}

function NextOccurrence({ automation }: { automation: Automation }) {
  if (!automation.enabled) return <span className="text-sm text-muted">Paused (disabled)</span>;
  if (!automation.nextAt) {
    const k = automation.trigger.kind;
    const text =
      k === "manual"
        ? "On demand"
        : k === "webhook"
          ? "On webhook"
          : k === "dependency"
            ? "When the task is done"
            : "None scheduled";
    return <span className="text-sm text-muted">{text}</span>;
  }
  return (
    <span className="flex min-w-0 flex-col text-sm">
      <span>{formatRelative(automation.nextAt)}</span>
      <time dateTime={automation.nextAt} className="text-xs text-muted">
        {formatAbsolute(automation.nextAt)}
      </time>
    </span>
  );
}

function HostWarning({ host }: { host: Host | undefined }) {
  if (!host || host.connectivity === "connected") return null;
  return (
    <span className="flex items-center gap-1 text-xs text-danger">
      <WifiOff aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        Host {host.name} {host.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
      </span>
    </span>
  );
}

function RunButton({
  running,
  onRun,
  name,
}: {
  running: boolean;
  onRun: () => void;
  name: string;
}) {
  return (
    <Button
      size="sm"
      busy={running}
      icon={<Play className="size-3.5" />}
      onClick={onRun}
      aria-label={`Run ${name} now`}
    >
      Run now
    </Button>
  );
}

function TableRow(p: RowProps) {
  const a = p.automation;
  return (
    <div className={cn(TABLE_COLS, "px-4 py-3")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          to={editPath(a.id)}
          state={BACK_STATE}
          className="truncate font-medium text-text hover:underline focus-visible:underline"
        >
          {a.name}
        </Link>
        <TriggerText automation={a} trigger={p.trigger} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="sr-only">Project: </span>
        <span className="truncate text-sm">{p.projectName}</span>
        <HostWarning host={p.host} />
      </div>
      <span className="text-sm">
        <span className="sr-only">Mode: </span>
        {modeLabel(a.mode)}
      </span>
      <div className="min-w-0">
        <span className="sr-only">Next occurrence: </span>
        <NextOccurrence automation={a} />
      </div>
      <div className="min-w-0 text-sm break-words">
        <span className="sr-only">Last outcome: </span>
        {a.lastOutcome ?? <span className="text-muted">No runs yet</span>}
      </div>
      <FailureCount count={a.failureCount} />
      <Switch
        checked={a.enabled}
        onChange={p.onToggle}
        busy={p.toggling}
        label={`Enable ${a.name}`}
        onText="Enabled"
        offText="Disabled"
      />
      <div className="flex items-center gap-1">
        <RunButton running={p.running} onRun={p.onRun} name={a.name} />
        <Link
          to={editPath(a.id)}
          state={BACK_STATE}
          aria-label={`Edit ${a.name}`}
          title="Edit"
          className="tap inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
        >
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      </div>
    </div>
  );
}

function CardRow(p: RowProps) {
  const a = p.automation;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to={editPath(a.id)}
            state={BACK_STATE}
            className="font-medium break-words text-text hover:underline focus-visible:underline"
          >
            {a.name}
          </Link>
          <TriggerText automation={a} trigger={p.trigger} />
        </div>
        <Switch
          checked={a.enabled}
          onChange={p.onToggle}
          busy={p.toggling}
          label={`Enable ${a.name}`}
          onText="Enabled"
          offText="Disabled"
        />
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Project</dt>
        <dd className="flex min-w-0 flex-col break-words">
          {p.projectName}
          <HostWarning host={p.host} />
        </dd>
        <dt className="text-muted">Mode</dt>
        <dd>{modeLabel(a.mode)}</dd>
        <dt className="text-muted">Next</dt>
        <dd className="min-w-0">
          <NextOccurrence automation={a} />
        </dd>
        <dt className="text-muted">Last outcome</dt>
        <dd className="min-w-0 break-words">
          {a.lastOutcome ?? <span className="text-muted">No runs yet</span>}
        </dd>
        <dt className="text-muted">Failures</dt>
        <dd>
          <FailureCount count={a.failureCount} />
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <RunButton running={p.running} onRun={p.onRun} name={a.name} />
        <Link to={editPath(a.id)} state={BACK_STATE} className={buttonClasses("ghost", "sm")}>
          Edit
          <ChevronRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
