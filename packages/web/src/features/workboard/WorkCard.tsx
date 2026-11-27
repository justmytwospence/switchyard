import { ArrowRightLeft, MessageCircleQuestion, MoreHorizontal, Play } from "lucide-react";
import { type CSSProperties, type HTMLAttributes, type Ref, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Menu, type MenuHeading, type MenuItem } from "../../components/ui/Menu";
import {
  REVIEW_STATUS,
  RUNTIME_STATUS,
  StatusChip,
  type StatusInfo,
} from "../../components/ui/StatusChip";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { LONG_PRESS_CLASS, useLongPress } from "../../lib/useLongPress";
import type { BoardCard, BoardColumn } from "./model";
import type { WorkBoard } from "./useWorkBoard";

function statusOf(card: BoardCard): StatusInfo | null {
  const s = card.branch?.primary;
  if (!s) return null;
  if (card.bucket === "review") return REVIEW_STATUS;
  if (card.bucket === "failed") return RUNTIME_STATUS.failed;
  const st = RUNTIME_STATUS[s.runtime];
  return s.runtime === "interrupted" ? { ...st, tone: "neutral" } : st;
}

/** One branch or not-started issue on the Board. */
export function WorkCard({
  card,
  board,
  column,
  dragRef,
  dragProps,
  style,
  dragging,
  phone,
}: {
  card: BoardCard;
  board: WorkBoard;
  column: BoardColumn;
  dragRef?: Ref<HTMLDivElement>;
  dragProps?: HTMLAttributes<HTMLDivElement>;
  style?: CSSProperties;
  dragging?: boolean;
  /** Phone layout: one actions menu in the title row, also opened by a long-press. */
  phone?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useLongPress(() => setMenuOpen(true), { enabled: !!phone });
  const status = statusOf(card);
  const pr = card.branch?.pullRequest ?? card.issue?.pullRequest ?? null;
  const context = [card.project, card.branchLabel, card.host].filter(Boolean).join(" · ");
  const targets: MenuItem[] = board.columns
    .filter((c) => c.id !== column.id)
    .map((c) => {
      const check = board.canDrop(card, c);
      return {
        id: `move-${c.id}`,
        label: c.label,
        disabled: !check.ok,
        hint: check.ok ? undefined : check.reason,
        onSelect: () => void board.move(card, c),
      };
    });
  const pr0 = card.branch?.pullRequest ?? card.issue?.pullRequest ?? null;
  const phoneItems: (MenuItem | MenuHeading)[] = [
    {
      id: "open",
      label: card.sessionId ? "Open session" : "Start session",
      icon: <Play className="size-4" />,
      onSelect: () => void board.activate(card),
    },
    ...(targets.length > 0 ? [{ id: "move", heading: "Move to" }] : []),
    ...targets,
    ...(card.issue
      ? [
          {
            id: "issue",
            label: `Open issue #${card.issue.number}`,
            onSelect: () => void window.open(card.issue?.url, "_blank", "noopener"),
          },
        ]
      : []),
    ...(pr0
      ? [
          {
            id: "pr",
            label: `Open pull request #${pr0.number}`,
            onSelect: () => void window.open(pr0.url, "_blank", "noopener"),
          },
        ]
      : []),
  ];
  return (
    <div
      ref={dragRef}
      {...dragProps}
      {...(phone ? press : {})}
      style={style}
      data-testid="work-card"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5 shadow-sm",
        phone && LONG_PRESS_CLASS,
        dragging && "opacity-40",
      )}
    >
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          className="tap min-w-0 flex-1 text-left"
          onClick={() => void board.activate(card)}
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <span className="min-w-0 flex-1 text-sm font-medium break-words">{card.title}</span>
            {card.attention && card.branch?.primary?.runtime !== "waiting_input" && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-warning">
                <MessageCircleQuestion aria-hidden className="size-3.5" />
                Needs input
              </span>
            )}
          </span>
          {context && <span className="block truncate text-xs text-muted">{context}</span>}
        </button>
        {phone && (
          <Menu
            label={`Actions for ${card.title}`}
            items={phoneItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={(p) => (
              <button
                type="button"
                {...p}
                aria-label={`Actions for ${card.title}`}
                className="tap -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded text-muted"
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </button>
            )}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {status && <StatusChip kind="custom" status={status} size="sm" />}
        {card.branch && !card.sessionId && <span>No session</span>}
        {card.leaves && (
          <span
            title={`In ${board.scope?.name ?? "this scope"} only while it is live. Pin it or link an issue to keep it.`}
          >
            No issue
          </span>
        )}
        {card.extraCount > 0 && <span>+{card.extraCount}</span>}
        {card.issue && (
          <a
            href={card.issue.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            #{card.issue.number}
          </a>
        )}
        {card.issue?.board?.priority && (
          <span data-testid="card-priority" title="Priority on the board">
            {card.issue.board.priority.name}
          </span>
        )}
        {card.issue?.parent && (
          <a
            href={card.issue.parent.url}
            target="_blank"
            rel="noreferrer"
            title={card.issue.parent.title}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Part of #{card.issue.parent.number}
          </a>
        )}
        {card.issue?.subIssues && (
          <span>
            {card.issue.subIssues.completed}/{card.issue.subIssues.total} sub-issues
          </span>
        )}
        {pr && (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            PR #{pr.number}
          </a>
        )}
        <span className="ml-auto">{formatRelative(card.lastActivityAt)}</span>
      </div>
      <div className="flex items-center gap-1">
        {!card.branch && card.issue && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Play className="size-3.5" />}
            onClick={() => void board.activate(card)}
          >
            Start session
          </Button>
        )}
        {card.branch && !card.sessionId && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Play className="size-3.5" />}
            onClick={() => void board.activate(card)}
          >
            Start session
          </Button>
        )}
        {!phone && targets.length > 0 && (
          <Menu
            label={`Move ${card.title}`}
            items={targets}
            trigger={(p) => (
              <Button
                {...p}
                size="sm"
                variant="ghost"
                icon={<ArrowRightLeft className="size-3.5" />}
              >
                Move to…
              </Button>
            )}
          />
        )}
      </div>
    </div>
  );
}
