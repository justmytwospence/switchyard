import type { Eligibility, Task, TaskState } from "@switchyard/protocol";
import {
  Bell,
  ExternalLink,
  GitBranch,
  GripVertical,
  Link2,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelRightOpen,
  Server,
} from "lucide-react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { Link, useNavigate } from "react-router";
import { ROUTES } from "../../app/routes";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Spinner } from "../../components/ui/Spinner";
import { ATTENTION_STATUS, TASK_STATUS } from "../../components/ui/StatusChip";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { useSyncStore } from "../../sync/store";
import { dependencySummary, moveTargets, STATE_LABELS } from "./logic";
import { useTaskMover } from "./MoveProvider";
import { executionLine, PRIORITY_INFO, useTaskInfo } from "./taskInfo";

const TONE_TEXT = {
  neutral: "text-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
} as const;

export interface DragBindings {
  setNodeRef: Ref<HTMLElement>;
  setHandleRef: Ref<HTMLButtonElement>;
  /** Pointer listeners for the whole card. */
  cardProps: HTMLAttributes<HTMLElement>;
  /** Keyboard listeners + attributes for the handle. */
  handleProps: HTMLAttributes<HTMLButtonElement>;
  dragging: boolean;
  style?: React.CSSProperties;
}

export interface TaskCardProps {
  task: Task;
  showProject: boolean;
  wait?: Eligibility;
  onOpen: (task: Task) => void;
  drag?: DragBindings;
  /** Card occupies full width (mobile). */
  full?: boolean;
  selected?: boolean;
}

/** Board card: title (2 lines), priority, execution/blocked reason, host, branch, deps, attention, activity. */
export function TaskCard({ task, showProject, wait, onOpen, drag, full, selected }: TaskCardProps) {
  const info = useTaskInfo(task);
  const tasks = useSyncStore((s) => s.tasks);
  const mover = useTaskMover();
  const navigate = useNavigate();
  const busy = mover.isBusy(task.id);
  const pr = PRIORITY_INFO[task.priority];
  const PrIcon = pr.icon;
  const exec = executionLine(task, info.run, wait);
  const deps = dependencySummary(task, tasks);
  const attention = info.attention[0];

  const items: (MenuItem | "separator")[] = [
    {
      id: "open",
      label: "Open details",
      icon: <PanelRightOpen className="size-4" />,
      onSelect: () => onOpen(task),
    },
  ];
  if (task.sessionId) {
    const sid = task.sessionId;
    items.push({
      id: "session",
      label: "Open session",
      icon: <ExternalLink className="size-4" />,
      onSelect: () => navigate(ROUTES.session(sid)),
    });
  }
  items.push("separator");
  for (const to of moveTargets(task)) {
    items.push({
      id: `move-${to}`,
      label: moveLabel(task.state, to),
      icon: <StateIcon state={to} />,
      onSelect: () => void mover.move(task, to),
    });
  }

  return (
    <article
      ref={drag?.setNodeRef as Ref<HTMLElement>}
      data-testid="task-card"
      data-task-id={task.id}
      aria-label={task.title}
      aria-busy={busy || undefined}
      style={drag?.style}
      {...drag?.cardProps}
      className={cn(
        "group relative flex min-w-0 flex-col gap-1.5 rounded-lg border bg-surface p-3 text-sm shadow-sm",
        selected ? "border-accent" : "border-border",
        drag?.dragging && "opacity-60",
        full ? "w-full" : "",
      )}
    >
      <div className="flex min-w-0 items-start gap-1">
        {drag && (
          <button
            type="button"
            ref={drag.setHandleRef}
            {...drag.handleProps}
            aria-label={`Drag ${task.title}`}
            title="Drag to move (Space to pick up, arrows to move, Space to drop)"
            className="tap -ml-1.5 inline-flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-subtle hover:bg-surface-2 hover:text-text"
          >
            <GripVertical aria-hidden className="size-4" />
          </button>
        )}
        <button
          type="button"
          data-card-open={task.id}
          onClick={() => onOpen(task)}
          className="tap min-w-0 flex-1 rounded text-left font-medium leading-snug"
        >
          <span className="line-clamp-2 break-words">{task.title}</span>
        </button>
        {busy && <Spinner label="Updating" className="mt-0.5 shrink-0" />}
        <Menu
          label={`Actions for ${task.title}`}
          items={items}
          trigger={(p) => (
            <button
              type="button"
              {...p}
              aria-label={`Move to… and other actions for ${task.title}`}
              title="Move to…"
              className="tap -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          )}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className={cn("inline-flex items-center gap-1", TONE_TEXT[pr.tone])}>
          <PrIcon aria-hidden className="size-3.5" />
          {pr.label}
        </span>
        {showProject && info.projectName && (
          <span className="min-w-0 truncate">{info.projectName}</span>
        )}
      </div>

      {exec && (
        <Line
          icon={
            exec.spin ? (
              <Spinner className="size-3.5" />
            ) : (
              <exec.icon aria-hidden className={cn("size-3.5", exec.pulse && "animate-pulse")} />
            )
          }
          className={TONE_TEXT[exec.tone]}
        >
          {exec.text}
        </Line>
      )}

      {(info.hostName || info.branch) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {info.hostName && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Server aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {info.hostName}
                {info.hostOffline ? " (offline)" : ""}
              </span>
            </span>
          )}
          {info.branch && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{info.branch}</span>
            </span>
          )}
        </div>
      )}

      {deps && (
        <Line icon={<Link2 aria-hidden className="size-3.5" />} className="text-muted">
          {deps}
        </Line>
      )}

      {info.pendingInteraction && task.sessionId ? (
        <Link
          to={ROUTES.interaction(task.sessionId, info.pendingInteraction.id)}
          className="tap inline-flex min-w-0 items-center gap-1 rounded text-xs font-medium text-warning hover:underline"
        >
          <MessageCircleQuestion aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">Needs input: {info.pendingInteraction.title}</span>
        </Link>
      ) : attention ? (
        <Line
          icon={<Bell aria-hidden className="size-3.5" />}
          className={TONE_TEXT[ATTENTION_STATUS[attention.reason].tone]}
        >
          {ATTENTION_STATUS[attention.reason].label}
          {info.attention.length > 1 ? ` (+${info.attention.length - 1})` : ""}
        </Line>
      ) : null}

      <div className="text-xs text-subtle">
        Updated <time dateTime={task.lastActivityAt}>{formatRelative(task.lastActivityAt)}</time>
      </div>
    </article>
  );
}

function Line({
  icon,
  children,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1 text-xs", className)}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 break-words line-clamp-2">{children}</span>
    </div>
  );
}

export function StateIcon({ state, className }: { state: TaskState; className?: string }) {
  const Icon = TASK_STATUS[state].icon;
  return <Icon aria-hidden className={cn("size-4", className)} />;
}

export function moveLabel(from: TaskState, to: TaskState): string {
  if (from === "ready" && to === "in_progress") return "Run now (In progress)";
  if (from === "review" && to === "in_progress") return "Start new attempt (In progress)";
  if (from === "backlog" && to === "ready") return "Make ready";
  if ((from === "done" || from === "canceled") && to !== "canceled")
    return `Reopen to ${STATE_LABELS[to]}`;
  if (to === "canceled") return "Cancel task";
  if (to === "done") return "Accept (Done)";
  return `Move to ${STATE_LABELS[to]}`;
}
