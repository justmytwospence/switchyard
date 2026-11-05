import type { AdapterInfo, Panel, Run, Task } from "@switchyard/protocol";
import { Bot, CircleCheck, Hand, Square, SquareKanban } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { CustomFrame } from "../../components/intent/CustomFrame";
import { Markdown } from "../../components/intent/Markdown";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { Button, buttonClasses } from "../../components/ui/Button";
import { StatusChip } from "../../components/ui/StatusChip";
import { UnsupportedCapability } from "../../components/ui/states";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatRelative, formatTime } from "../../lib/time";
import { errorMessage } from "../../sync/api";
import { usePanels, useRunsForTask, useSyncStore, useTranscript } from "../../sync/store";
import { codeApi } from "./api";
import { ControlChip } from "./ConversationHeader";
import { useCodeContext } from "./context";
import type { SessionContext } from "./hooks";
import { contextMeter, modelLabel, workspaceLabel } from "./model";
import type { SessionActions } from "./SessionActions";

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Take over, Return to automation and Stop: only the controls that apply, each explained. */
export function ControlButtons({ ctx, actions }: { ctx: SessionContext; actions: SessionActions }) {
  const { canTakeover, canReturn, canStop } = actions;
  if (!canTakeover && !canReturn && !canStop) {
    return <p className="text-sm text-muted">Manual session: no automation run controls it.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ControlChip ctx={ctx} />
      <div className="flex flex-wrap gap-2">
        {canTakeover && (
          <Button
            icon={<Hand className="size-4" />}
            busy={actions.busy.takeover}
            onClick={actions.takeover}
          >
            Take over
          </Button>
        )}
        {canReturn && (
          <Button
            icon={<Bot className="size-4" />}
            busy={actions.busy.ret}
            onClick={actions.returnToAutomation}
          >
            Return to automation
          </Button>
        )}
        {canStop && (
          <Button
            variant={ctx.session.runtime === "waiting_input" ? "secondary" : "danger"}
            icon={<Square className="size-4" />}
            busy={actions.busy.stop}
            onClick={actions.requestStop}
          >
            Stop
          </Button>
        )}
      </div>
      {(canTakeover || canReturn) && (
        <p className="text-xs text-muted">
          {ctx.control === "automation"
            ? "Taking over pauses automatic continuations; Pi keeps running."
            : "You have control; returning lets automation continue."}
        </p>
      )}
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Attempt {run.attempt}</span>
        <StatusChip kind="run" value={run.state} size="sm" />
        <span className="text-xs text-muted">
          {run.startedAt ? formatTime(run.startedAt) : formatTime(run.createdAt)}
        </span>
      </div>
      {run.outcome && <p className="text-xs break-words text-muted">{run.outcome.summary}</p>}
      <p className="text-xs text-muted">
        {run.usage.accounting === "available"
          ? [
              run.usage.tokens !== null ? `${run.usage.tokens.toLocaleString()} tokens` : null,
              run.usage.costUsd !== null ? `$${run.usage.costUsd.toFixed(2)}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No usage reported"
          : (run.usage.note ?? "Token/cost accounting not reported")}
        {run.continuationsUsed > 0 && ` · ${run.continuationsUsed} continuations`}
      </p>
    </li>
  );
}

function Limits({ task, run }: { task: Task; run: Run | null }) {
  const c = run?.limits ?? task.policy.continuation;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted">Continuation</dt>
      <dd>{c.enabled ? "Enabled" : "Off: stops after one turn"}</dd>
      {c.enabled && (
        <>
          <dt className="text-muted">Continuations</dt>
          <dd>
            {run ? `${run.continuationsUsed} of ` : "up to "}
            {c.maxContinuations}
          </dd>
          <dt className="text-muted">Time limit</dt>
          <dd>{c.maxElapsedMinutes} min</dd>
          <dt className="text-muted">Token limit</dt>
          <dd>{c.maxTokens?.toLocaleString() ?? "None"}</dd>
          <dt className="text-muted">Cost limit</dt>
          <dd>{c.maxCostUsd !== null ? `$${c.maxCostUsd}` : "None"}</dd>
        </>
      )}
      <dt className="text-muted">Checks</dt>
      <dd className="min-w-0 break-words">
        {task.policy.completion.checks === null
          ? "Project checks"
          : task.policy.completion.checks.length
            ? task.policy.completion.checks.join(", ")
            : "None"}
      </dd>
      <dt className="text-muted">Human review</dt>
      <dd>{task.policy.completion.requireHumanReview ? "Required" : "Not required"}</dd>
    </dl>
  );
}

/** Linked task: objective, criteria, dependencies, limits, run history and takeover controls. */
export function TaskSection({
  ctx,
  actions,
  showControls = true,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  /** Mobile Details shows the control buttons in their own section. */
  showControls?: boolean;
}) {
  const { task, run } = ctx;
  const runs = useRunsForTask(task?.id);
  const tasks = useSyncStore((s) => s.tasks);
  if (!task) {
    return <p className="text-sm text-muted">No linked task: this session was started directly.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-semibold break-words">{task.title}</h3>
          <StatusChip kind="task" value={task.state} size="sm" />
        </div>
        {task.blocked && <p className="text-sm text-warning">Blocked: {task.blocked.reason}</p>}
        <Link
          to={`/tasks/${encodeURIComponent(task.id)}`}
          className={buttonClasses("secondary", "sm", "self-start")}
        >
          <SquareKanban aria-hidden className="size-4" />
          Open task
        </Link>
      </div>
      <Section title="Objective">
        {task.objective ? (
          <Markdown text={task.objective} />
        ) : (
          <p className="text-sm text-muted">No objective written.</p>
        )}
      </Section>
      <Section title="Acceptance criteria">
        {task.acceptanceCriteria.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.acceptanceCriteria.map((c) => (
              <li key={c} className="flex items-start gap-2 text-sm">
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0 break-words">{c}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Dependencies">
        {task.dependencies.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.dependencies.map((id) => {
              const dep = tasks[id];
              return (
                <li key={id} className="flex min-w-0 items-center gap-2 text-sm">
                  {dep ? <StatusChip kind="task" value={dep.state} size="sm" /> : null}
                  <TextLink to={`/tasks/${encodeURIComponent(id)}`} size="sm" className="truncate">
                    {dep?.title ?? id}
                  </TextLink>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Limits">
        <Limits task={task} run={run} />
      </Section>
      {showControls && (
        <Section title="Control">
          <ControlButtons ctx={ctx} actions={actions} />
        </Section>
      )}
      <Section title="Run history">
        {runs.length === 0 ? (
          <p className="text-sm text-muted">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

const ADAPTER_STATUS = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
} as const;

function AdapterRow({ a }: { a: AdapterInfo }) {
  const s = ADAPTER_STATUS[a.status];
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm">{a.id}</span>
        <span className="text-xs text-muted">v{a.version}</span>
        <span className="rounded-full border border-border px-1.5 text-xs text-muted">
          Tier: {a.tier}
        </span>
        <StatusChip
          kind="custom"
          size="sm"
          status={{
            label: s.label,
            tone: s.tone,
            icon: a.status === "active" ? CircleCheck : Square,
          }}
        />
      </div>
      <p className="text-xs break-words text-muted">
        For {a.target.extension} {a.target.versionRange}
        {a.target.testedVersions.length > 0 && ` (tested ${a.target.testedVersions.join(", ")})`}
      </p>
      {a.capabilities.length > 0 && (
        <p className="text-xs text-muted">Provides: {a.capabilities.join(", ")}</p>
      )}
      {a.detail && <p className="text-xs break-words text-warning">{a.detail}</p>}
    </li>
  );
}

function PanelView({ ctx, panel }: { ctx: SessionContext; panel: Panel }) {
  const { mobile, openFile } = useCodeContext();
  const onAction = (actionId: string, payload?: unknown) => {
    codeApi
      .adapterAction(ctx.session.id, panel.adapterId, actionId, payload)
      .then(() => toast.success("Action sent"))
      .catch((e) => toast.error(errorMessage(e)));
  };
  let body: ReactNode;
  if (panel.webRenderer && !mobile && ctx.host) {
    body = (
      <CustomFrame
        hostId={ctx.session.hostId}
        adapterId={panel.adapterId}
        node={panel.node}
        title={panel.title}
        onAction={onAction}
      />
    );
  } else if (panel.node) {
    body = (
      <>
        {panel.webRenderer && mobile && (
          <p className="text-xs text-muted">
            Showing the portable version; this panel&apos;s custom renderer is desktop-only.
          </p>
        )}
        <UINodeRenderer node={panel.node} onAction={(id) => onAction(id)} onOpenFile={openFile} />
      </>
    );
  } else {
    body = (
      <UnsupportedCapability
        capability="This panel"
        reason="It only has a custom web renderer, which is desktop-only and is not shown on mobile."
        fallback={
          <p className="text-sm">
            {panel.mobileFallback ?? "The adapter provides no mobile fallback text."}
          </p>
        }
      />
    );
  }
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
      <header className="flex min-w-0 items-baseline gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{panel.title}</h4>
        <span className="shrink-0 font-mono text-xs text-subtle">{panel.adapterId}</span>
      </header>
      {body}
    </article>
  );
}

/** Extension panels, adapter compatibility and diagnostics. */
export function ExtensionsSection({ ctx }: { ctx: SessionContext }) {
  const panels = usePanels(ctx.session.id);
  const diagnostics = useSyncStore((s) => s.diagnostics);
  const adapterIds = useMemo(() => new Set(ctx.adapters.map((a) => a.id)), [ctx.adapters]);
  const mine = useMemo(
    () =>
      diagnostics
        .filter(
          (d) =>
            d.sessionId === ctx.session.id ||
            (d.sessionId === null && d.adapterId !== null && adapterIds.has(d.adapterId)),
        )
        .slice(-20)
        .reverse(),
    [diagnostics, ctx.session.id, adapterIds],
  );
  const caps = ctx.host?.capabilities;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title="Panels">
        {panels.length === 0 ? (
          <p className="text-sm text-muted">No extension panels for this session.</p>
        ) : (
          panels.map((p) => <PanelView key={`${p.adapterId}:${p.slot}`} ctx={ctx} panel={p} />)
        )}
      </Section>
      <Section title={`Adapters on ${ctx.hostName}`}>
        {ctx.adapters.length === 0 ? (
          <p className="text-sm text-muted">No adapters reported by this host.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ctx.adapters.map((a) => (
              <AdapterRow key={a.id} a={a} />
            ))}
          </ul>
        )}
      </Section>
      {(caps?.unsupported.length || ctx.host?.piCompatible === false) && (
        <Section title="Runtime limitations">
          {ctx.host?.piCompatible === false && (
            <UnsupportedCapability
              capability="This Pi version"
              reason={`Pi ${ctx.host.piVersion ?? "(not found)"} on ${ctx.hostName} is outside the tested range.`}
            />
          )}
          {caps?.unsupported.map((u) => (
            <UnsupportedCapability key={u.capability} capability={u.capability} reason={u.reason} />
          ))}
        </Section>
      )}
      <Section title="Diagnostics">
        {mine.length === 0 ? (
          <p className="text-sm text-muted">No diagnostics.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {mine.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id
                key={`${d.at}-${i}`}
                className="min-w-0 rounded-md bg-surface-2 px-2 py-1 text-xs"
              >
                <span
                  className={cn(
                    "font-medium",
                    d.level === "error" && "text-danger",
                    d.level === "warning" && "text-warning",
                  )}
                >
                  {d.level === "error" ? "Error" : d.level === "warning" ? "Warning" : "Info"}
                </span>{" "}
                {d.adapterId && <span className="font-mono">{d.adapterId}: </span>}
                <span className="break-words">{d.message}</span>{" "}
                <span className="text-subtle">{formatRelative(d.at)}</span>
              </li>
            ))}
          </ul>
        )}
        <TextLink to="/settings/diagnostics" size="sm">
          All diagnostics
        </TextLink>
      </Section>
    </div>
  );
}

/** Project, host, branch, model and context facts for a session. */
export function SessionFacts({ ctx }: { ctx: SessionContext }) {
  const { session, workspace, host } = ctx;
  const meter = contextMeter(session);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted">Project</dt>
      <dd className="min-w-0 break-words">{ctx.project?.name ?? "None"}</dd>
      <dt className="text-muted">Host</dt>
      <dd className="min-w-0 break-words">
        {ctx.hostName}
        {ctx.link !== "connected" && ` (${ctx.link})`}
        {host?.piVersion && ` · Pi ${host.piVersion}`}
      </dd>
      <dt className="text-muted">Control</dt>
      <dd>{ctx.control === "none" ? "Manual session" : <ControlChip ctx={ctx} />}</dd>
      <dt className="text-muted">Branch</dt>
      <dd className="min-w-0 font-mono text-xs break-all">
        {workspaceLabel(workspace, session.cwd)}
        {workspace?.baseBranch && ` (from ${workspace.baseBranch})`}
      </dd>
      <dt className="text-muted">Path</dt>
      <dd className="min-w-0 font-mono text-xs break-all">{workspace?.path ?? session.cwd}</dd>
      {workspace && (
        <>
          <dt className="text-muted">Git</dt>
          <dd>
            {workspace.git.dirty ? `${workspace.git.changedFiles} changed files` : "Clean"}
            {workspace.git.ahead > 0 && ` · ${workspace.git.ahead} ahead`}
            {workspace.git.behind > 0 && ` · ${workspace.git.behind} behind`}
          </dd>
        </>
      )}
      <dt className="text-muted">Profile</dt>
      <dd className="min-w-0 break-words">{session.profileSnapshot.name}</dd>
      {session.model && (
        <>
          <dt className="text-muted">Model</dt>
          <dd className="min-w-0 break-words">
            {`${modelLabel(session.model)} (${session.model.provider}/${session.model.id})`}
            {session.thinking && ` · effort ${session.thinking}`}
          </dd>
        </>
      )}
      {meter && (
        <>
          <dt className="text-muted">Context</dt>
          <dd className="min-w-0 break-words">{`${meter.label} · ${meter.detail}`}</dd>
        </>
      )}
    </dl>
  );
}

/** Mobile Details: facts, control, task, subagents, extensions. */
export function MobileDetails({ ctx, actions }: { ctx: SessionContext; actions: SessionActions }) {
  const transcript = useTranscript(ctx.session.id);
  const subagents = transcript.items.filter((i) => i.kind === "subagent");
  return (
    <div className="flex min-w-0 flex-col gap-5 px-3 py-3">
      <Section title="Session">
        <SessionFacts ctx={ctx} />
      </Section>
      <Section title="Automation and control">
        <ControlButtons ctx={ctx} actions={actions} />
      </Section>
      <Section title="Task">
        <TaskSection ctx={ctx} actions={actions} showControls={false} />
      </Section>
      <Section title="Subagents">
        {subagents.length === 0 ? (
          <p className="text-sm text-muted">No subagents in the loaded transcript.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {subagents.map((s) =>
              s.kind === "subagent" ? (
                <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 truncate">{s.data.label}</span>
                  <span className="text-xs text-muted">{s.data.status}</span>
                  {s.data.linkedSessionId && (
                    <TextLink to={`/code/${encodeURIComponent(s.data.linkedSessionId)}`}>
                      Open (view only)
                    </TextLink>
                  )}
                </li>
              ) : null,
            )}
          </ul>
        )}
      </Section>
      <Section title="Extensions">
        <ExtensionsSection ctx={ctx} />
      </Section>
    </div>
  );
}
