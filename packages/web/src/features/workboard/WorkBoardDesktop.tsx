import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SquareKanban } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { cn } from "../../lib/cn";
import { usePrefs } from "../../prefs";
import { ViewSelect } from "../views/ViewSelect";
import { BoardSearch } from "./BoardSearch";
import type { BoardCard, BoardColumn } from "./model";
import type { WorkBoard } from "./useWorkBoard";
import { WorkCard } from "./WorkCard";

/** Desktop and compact Board: one column per stage (or tracker board column); drag to move. */
export function WorkBoardDesktop({ board }: { board: WorkBoard }) {
  const colWidth = usePrefs((s) => s.paneSizes.boardColumn);
  const [active, setActive] = useState<{ card: BoardCard; from: BoardColumn } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const find = (key: string) => {
    for (const c of board.columns) {
      const card = c.cards.find((x) => x.key === key);
      if (card) return { card, from: c };
    }
    return null;
  };
  const onDragStart = (e: DragStartEvent) => setActive(find(String(e.active.id)));
  const onDragEnd = (e: DragEndEvent) => {
    const a = active;
    setActive(null);
    if (!a || !e.over) return;
    const to = board.columns.find((c) => c.id === String(e.over!.id));
    if (!to || to.id === a.from.id) return;
    void board.move(a.card, to);
  };

  return (
    <div data-testid="workboard" className="absolute inset-0 flex min-w-0 flex-col">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="mr-2 text-lg font-semibold">Board</h1>
        <ViewSelect allLabel="All work" />
        <BoardSearch board={board} className="w-56 max-w-full" />
        {board.trackerBoard && <ColumnsControl board={board} />}
        <EmptyWorktreesToggle board={board} />
        {board.view && (
          <p className="ml-auto truncate text-xs text-subtle">{board.describe(board.view)}</p>
        )}
      </header>
      {!board.hydrated ? (
        <LoadingState label="Loading the board…" />
      ) : board.total === 0 ? (
        <BoardEmpty board={board} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActive(null)}
        >
          <section
            aria-label="Board columns"
            data-keyboard-columns
            data-keyboard-default
            className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <div className="flex h-full w-max gap-3 p-4">
              {board.columns.map((c) => (
                <Column
                  key={c.id}
                  column={c}
                  board={board}
                  width={colWidth}
                  drop={
                    active && active.from.id !== c.id
                      ? board.canDrop(active.card, c).ok
                        ? "valid"
                        : "invalid"
                      : null
                  }
                  reason={
                    active && active.from.id !== c.id
                      ? (() => {
                          const r = board.canDrop(active.card, c);
                          return r.ok ? null : r.reason;
                        })()
                      : null
                  }
                />
              ))}
            </div>
          </section>
          <DragOverlay dropAnimation={null}>
            {active && (
              <div
                className="rotate-1 shadow-pop"
                style={{ width: `clamp(272px, ${colWidth - 16}px, 344px)` }}
              >
                <WorkCard card={active.card} board={board} column={active.from} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

/** Worktrees with no session, issue or pull request stay off the Board until asked for. */
export function EmptyWorktreesToggle({ board }: { board: WorkBoard }) {
  if (board.emptyCount === 0) return null;
  const n = board.emptyCount;
  return (
    <button
      type="button"
      aria-pressed={board.prefs.empty}
      title="Worktrees with no session, issue or pull request"
      onClick={() => board.setPrefs({ ...board.prefs, empty: !board.prefs.empty })}
      className="rounded-md px-2 py-1 text-xs text-subtle hover:bg-surface-2 hover:text-fg"
    >
      {board.prefs.empty ? "Hide" : "Show"} {n} {n === 1 ? "worktree" : "worktrees"} without a
      session
    </button>
  );
}

export function ColumnsControl({ board, block }: { board: WorkBoard; block?: boolean }) {
  if (!board.trackerBoard) return null;
  return (
    <SegmentedControl
      label="Columns"
      block={block}
      value={board.mode}
      onChange={(mode) => board.setPrefs({ ...board.prefs, mode })}
      options={[
        { value: "stage", label: "Stage" },
        { value: "tracker", label: `${board.trackerBoard.tracker.name} board` },
      ]}
    />
  );
}

export function BoardEmpty({ board }: { board: WorkBoard }) {
  return (
    <EmptyState
      icon={<SquareKanban className="size-8" />}
      title={board.view ? "No branches in this view" : "No branches yet"}
      description={
        board.view
          ? board.describe(board.view)
          : "Start a session or a tracker issue and its branch appears here."
      }
      action={board.view ? { label: "All work", onClick: board.clearView } : undefined}
    />
  );
}

function Column({
  column,
  board,
  width,
  drop,
  reason,
}: {
  column: BoardColumn;
  board: WorkBoard;
  width: number;
  drop: "valid" | "invalid" | null;
  reason: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const headingId = `work-col-${column.id}-title`;
  return (
    <section
      ref={setNodeRef}
      data-testid={`work-column-${column.id}`}
      aria-labelledby={headingId}
      tabIndex={-1}
      data-keyboard-scope
      data-keyboard-column
      data-drop={drop ?? undefined}
      style={{ width: `clamp(288px, ${width}px, 360px)` }}
      className={cn(
        "flex h-full shrink-0 flex-col rounded-lg border bg-surface-2",
        drop === "invalid"
          ? cn("border-dashed opacity-50", isOver ? "border-danger" : "border-border")
          : isOver
            ? "border-accent"
            : "border-border",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <h2
          id={headingId}
          className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        >
          <span className="flex-1">{column.label}</span>
          {reason && (
            <span className="truncate text-xs font-normal text-muted" title={reason}>
              {reason}
            </span>
          )}
          <span className="rounded-full bg-surface px-2 text-xs font-medium text-muted tabular-nums">
            {column.cards.length}
            <span className="sr-only"> cards</span>
          </span>
        </h2>
        <ul className="flex flex-col gap-2 p-2">
          {column.cards.length === 0 ? (
            <li className="px-1 py-2 text-sm text-muted">Nothing here</li>
          ) : (
            column.cards.map((card) => (
              <li key={card.key}>
                <DraggableCard card={card} column={column} board={board} />
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}

function DraggableCard({
  card,
  column,
  board,
}: {
  card: BoardCard;
  column: BoardColumn;
  board: WorkBoard;
}) {
  const drag = useDraggable({ id: card.key });
  return (
    <WorkCard
      card={card}
      board={board}
      column={column}
      dragRef={drag.setNodeRef}
      dragProps={{ ...drag.attributes, ...drag.listeners, role: undefined, tabIndex: undefined }}
      dragging={drag.isDragging}
    />
  );
}
