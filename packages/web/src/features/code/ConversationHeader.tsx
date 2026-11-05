import {
  Archive,
  ArchiveRestore,
  Bot,
  EllipsisVertical,
  GitBranch,
  Hand,
  Info,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Server,
  Square,
  SquareKanban,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Button, buttonClasses } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { StatusChip } from "../../components/ui/StatusChip";
import { type SessionContext, useElementWidth } from "./hooks";
import { AUTOMATION_LABEL, workspaceLabel } from "./model";
import type { SessionActions } from "./SessionActions";

/** Automation-control state as icon + text. */
export function ControlChip({ ctx, className }: { ctx: SessionContext; className?: string }) {
  if (ctx.control === "none") return null;
  const automation = ctx.control === "automation";
  return (
    <StatusChip
      kind="custom"
      size="sm"
      className={className}
      status={{
        label: AUTOMATION_LABEL[ctx.control],
        icon: automation ? Bot : Hand,
        tone: automation ? "info" : "neutral",
      }}
    />
  );
}

export function HostChip({ ctx }: { ctx: SessionContext }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted">
      <Server aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{ctx.hostName}</span>
      {ctx.link !== "connected" && (
        <StatusChip kind="host" value={ctx.link} size="sm" className="ml-1" />
      )}
    </span>
  );
}

export function sessionMenuItems(ctx: SessionContext, a: SessionActions): MenuItem[] {
  return [
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil className="size-4" />,
      onSelect: a.openRename,
      disabled: ctx.session.readOnly,
    },
    ctx.session.archivedAt
      ? {
          id: "unarchive",
          label: "Unarchive",
          icon: <ArchiveRestore className="size-4" />,
          onSelect: a.unarchive,
        }
      : {
          id: "archive",
          label: "Archive",
          icon: <Archive className="size-4" />,
          onSelect: a.requestArchive,
          disabled: !!a.archiveBlocked,
          hint: a.archiveBlocked ?? undefined,
        },
    {
      id: "info",
      label: "Session info",
      icon: <Info className="size-4" />,
      onSelect: a.openInfo,
    },
  ];
}

/** Desktop/compact conversation header: identity, status, control state and actions. */
export function ConversationHeader({
  ctx,
  actions,
  inspector,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  inspector: { open: boolean; toggle: () => void; label: string };
}) {
  const { session, project, workspace, task } = ctx;
  const navigate = useNavigate();
  const [ref, width] = useElementWidth<HTMLElement>();
  const narrow = width > 0 && width < 640;
  const menuItems: MenuItem[] = [
    ...(narrow && task
      ? [
          {
            id: "task",
            label: "Open linked task",
            icon: <SquareKanban className="size-4" />,
            onSelect: () => navigate(`/tasks/${encodeURIComponent(task.id)}`),
          },
        ]
      : []),
    ...sessionMenuItems(ctx, actions),
  ];
  return (
    <header
      ref={ref}
      className="flex min-w-0 shrink-0 flex-col gap-1.5 border-b border-border bg-surface px-4 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={session.title}>
          {session.title}
        </h1>
        {task && !narrow && (
          <Link
            to={`/tasks/${encodeURIComponent(task.id)}`}
            className={buttonClasses("ghost", "sm")}
            title={`Open linked task: ${task.title}`}
          >
            <SquareKanban aria-hidden className="size-4" />
            <span className="hidden xl:inline">Open linked task</span>
            <span className="xl:hidden">Task</span>
          </Link>
        )}
        {actions.canStop && (
          <Button
            size="sm"
            variant={session.runtime === "waiting_input" ? "secondary" : "danger"}
            icon={<Square className="size-3.5" />}
            busy={actions.busy.stop}
            onClick={actions.requestStop}
          >
            Stop
          </Button>
        )}
        <Menu
          label="Session menu"
          items={menuItems}
          trigger={(p) => (
            <IconButton
              {...p}
              label="Session menu"
              icon={<EllipsisVertical className="size-4" />}
            />
          )}
        />
        <IconButton
          label={inspector.label}
          aria-expanded={inspector.open}
          icon={
            inspector.open ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )
          }
          onClick={inspector.toggle}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <StatusChip kind="runtime" value={session.runtime} size="sm" />
        <ControlChip ctx={ctx} />
        <span className="min-w-0 truncate text-xs text-muted">{project?.name ?? "No project"}</span>
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted">
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
          <span className="sr-only">Branch </span>
          <span className="truncate font-mono">{workspaceLabel(workspace, session.cwd)}</span>
        </span>
        <HostChip ctx={ctx} />
      </div>
    </header>
  );
}
