import type { View } from "@switchyard/protocol";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  Bot,
  CircleDot,
  EllipsisVertical,
  GitBranch,
  Hand,
  Info,
  Link2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Server,
  Square,
  SquareKanban,
  Unlink2,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Button, buttonClasses } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StatusChip } from "../../components/ui/StatusChip";
import { useSyncStore } from "../../sync/store";
import { type SessionContext, useElementWidth } from "./hooks";
import { AUTOMATION_LABEL, viewNote, workspaceLabel } from "./model";
import { useSessionPlace } from "./place";
import type { SessionActions } from "./SessionActions";
import type { Surface } from "./surface";

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

export function sessionMenuItems(
  ctx: SessionContext,
  a: SessionActions,
  views: View[] = [],
): MenuItem[] {
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
    ...(a.dismissAttention
      ? [
          {
            id: "dismiss-attention",
            label: "Clear Needs input",
            icon: <BellOff className="size-4" />,
            onSelect: a.dismissAttention,
          },
        ]
      : []),
    ...(ctx.session.provenance !== "subagent" && !ctx.session.archivedAt
      ? [
          {
            id: "primary",
            label: "Primary session of this branch",
            kind: "checkbox" as const,
            checked: a.isPrimary,
            onSelect: () => a.setPrimary(!a.isPrimary),
          },
        ]
      : []),
    ...(a.newInBranch
      ? [
          {
            id: "another",
            label: "New session in this branch",
            icon: <Plus className="size-4" />,
            onSelect: a.newInBranch,
          },
        ]
      : []),
    ...(a.issueLink?.linked && a.issueLink.canUnlink
      ? [
          {
            id: "unlink-issue",
            label: `Unlink from #${a.issueLink.linked.number}`,
            icon: <Unlink2 className="size-4" />,
            onSelect: a.issueLink.unlink,
          },
        ]
      : a.issueLink && !a.issueLink.linked && a.issueLink.candidates.length > 0
        ? [
            {
              id: "link-issue",
              label: "Link to issue…",
              icon: <Link2 className="size-4" />,
              onSelect: a.issueLink.open,
            },
          ]
        : []),
    ...views.map(
      (v): MenuItem => ({
        id: `view-${v.id}`,
        label: `Pin to ${v.name}`,
        kind: "checkbox",
        checked: v.sessionIds.includes(ctx.session.id),
        onSelect: () => a.setPinned(v.id, !v.sessionIds.includes(ctx.session.id)),
      }),
    ),
    {
      id: "cache-alert",
      label: "Warn before the prompt cache expires",
      kind: "checkbox",
      checked: !!ctx.session.cacheAlert,
      onSelect: a.toggleCacheAlert,
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
  surface,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  inspector: { open: boolean; toggle: () => void; label: string };
  /** Chat/Terminal switch, shown when the session has a terminal. */
  surface?: { value: Surface; onChange: (v: Surface) => void } | null;
}) {
  const { session, project, workspace, task } = ctx;
  const navigate = useNavigate();
  const views = useSyncStore((st) => st.views);
  const [ref, width] = useElementWidth<HTMLElement>();
  const place = useSessionPlace(session);
  const note = viewNote(place, session);
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
    ...sessionMenuItems(ctx, actions, Object.values(views)),
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
        {surface && (
          <SegmentedControl<Surface>
            label="Session surface"
            value={surface.value}
            onChange={surface.onChange}
            options={[
              { value: "chat", label: "Chat" },
              { value: "terminal", label: "Terminal" },
            ]}
          />
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
        {place.issue && (
          <a
            data-testid="session-issue"
            href={place.issue.url}
            target="_blank"
            rel="noreferrer"
            title={place.issue.title}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:underline"
          >
            <CircleDot aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only">Issue </span>#{place.issue.number}
          </a>
        )}
        {note && (
          <span data-testid="view-note" title={note.title} className="shrink-0 text-xs text-subtle">
            {note.label}
          </span>
        )}
      </div>
    </header>
  );
}
