import { ArrowRightLeft, MessageCircleQuestion, Play } from "lucide-react";
import type { CSSProperties, HTMLAttributes, Ref } from "react";
import { Button } from "../../components/ui/Button";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import {
  REVIEW_STATUS,
  RUNTIME_STATUS,
  StatusChip,
  type StatusInfo,
} from "../../components/ui/StatusChip";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
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
}: {
  card: BoardCard;
  board: WorkBoard;
  column: BoardColumn;
  dragRef?: Ref<HTMLDivElement>;
  dragProps?: HTMLAttributes<HTMLDivElement>;
  style?: CSSProperties;
  dragging?: boolean;
}) {
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
  return (
    <div
      ref={dragRef}
      {...dragProps}
      style={style}
      data-testid="work-card"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5 shadow-sm",
        dragging && "opacity-40",
      )}
    >
      <button
        type="button"
        className="tap min-w-0 text-left"
        onClick={() => void board.activate(card)}
      >
        <span className="flex min-w-0 items-start gap-1.5">
          <span className="min-w-0 flex-1 text-sm font-medium break-words">{card.title}</span>
          {card.attention && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-warning">
              <MessageCircleQuestion aria-hidden className="size-3.5" />
              Needs input
            </span>
          )}
        </span>
        {context && <span className="block truncate text-xs text-muted">{context}</span>}
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {status && <StatusChip kind="custom" status={status} size="sm" />}
        {card.branch && !card.sessionId && <span>No session</span>}
        {card.leaves && (
          <span
            title={`In ${board.view?.name ?? "this view"} only while it is live. Pin it or link an issue to keep it.`}
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
        {targets.length > 0 && (
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
