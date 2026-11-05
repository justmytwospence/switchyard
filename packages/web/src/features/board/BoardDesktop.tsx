import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Task, TaskState } from "@switchyard/protocol";
import { Plus, SquareKanban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ROUTES } from "../../app/routes";
import { BACK_STATE, useBackTo } from "../../app/useBackTo";
import { Button } from "../../components/ui/Button";
import { Dialog, Drawer } from "../../components/ui/Overlay";
import { TASK_STATUS } from "../../components/ui/StatusChip";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { usePrefs } from "../../prefs";
import { useSyncStore } from "../../sync/store";
import {
  BoardNotices,
  CompletedToggle,
  DispatchToggle,
  FilterButton,
  FilterChips,
  ProjectSelect,
  SearchBox,
  SortSelect,
} from "./BoardChrome";
import { DEFAULT_FILTERS, positionFor, STATE_LABELS } from "./logic";
import { useTaskMover } from "./MoveProvider";
import { NewTaskForm } from "./NewTaskForm";
import { type DragBindings, TaskCard } from "./TaskCard";
import { PrimaryAction, TaskDetailBody, useEligibility } from "./TaskDetail";
import { type BoardState, boardMemory, useBoard } from "./useBoard";

const COL_PREFIX = "col:";
const CARD_PREFIX = "card:";
const TASK_PREFIX = "task:";

/** Arrow keys jump between columns while a card is picked up with the keyboard. */
const columnCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const step = 72;
  if (event.code === "ArrowDown") return { ...currentCoordinates, y: currentCoordinates.y + step };
  if (event.code === "ArrowUp") return { ...currentCoordinates, y: currentCoordinates.y - step };
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();
  const cols = context.droppableContainers
    .toArray()
    .filter((c) => String(c.id).startsWith(COL_PREFIX))
    .map((c) => ({ id: c.id, rect: context.droppableRects.get(c.id) }))
    .filter((c): c is { id: typeof c.id; rect: NonNullable<typeof c.rect> } => !!c.rect)
    .sort((a, b) => a.rect.left - b.rect.left);
  if (cols.length === 0) return undefined;
  const width = context.collisionRect?.width ?? 0;
  const cx = currentCoordinates.x + width / 2;
  let idx = cols.findIndex((c) => cx >= c.rect.left && cx <= c.rect.left + c.rect.width);
  if (idx < 0) idx = 0;
  const next =
    cols[Math.max(0, Math.min(cols.length - 1, idx + (event.code === "ArrowRight" ? 1 : -1)))]!;
  return { x: next.rect.left + (next.rect.width - width) / 2, y: currentCoordinates.y };
};

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length > 0) {
    const card = hits.find((h) => String(h.id).startsWith(CARD_PREFIX));
    return card ? [card] : hits;
  }
  return closestCenter(args);
};

function stateOfOver(
  id: string,
  tasks: Record<string, Task>,
): { state: TaskState; beforeId: string | null } | null {
  if (id.startsWith(COL_PREFIX))
    return { state: id.slice(COL_PREFIX.length) as TaskState, beforeId: null };
  if (id.startsWith(CARD_PREFIX)) {
    const t = tasks[id.slice(CARD_PREFIX.length)];
    return t ? { state: t.state, beforeId: t.id } : null;
  }
  return null;
}

export function BoardDesktop({ taskId }: { taskId?: string }) {
  const board = useBoard();
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const tasks = useSyncStore((s) => s.tasks);
  const mover = useTaskMover();
  const navigate = useNavigate();
  const back = useBackTo(ROUTES.board);
  const colWidth = usePrefs((s) => s.paneSizes.boardColumn);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnCoordinateGetter,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  // Restore horizontal scroll after returning from the drawer route (the board remounts).
  const scrollerRef = useCallback((el: HTMLElement | null) => {
    if (el) el.scrollLeft = boardMemory.boardScrollLeft;
  }, []);

  useEffect(() => {
    if (taskId || !boardMemory.focusTaskId) return;
    const id = boardMemory.focusTaskId;
    boardMemory.focusTaskId = null;
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-card-open="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: false }),
    );
  }, [taskId]);

  const open = (t: Task) => {
    boardMemory.focusTaskId = t.id;
    navigate(ROUTES.task(t.id), { state: BACK_STATE });
  };
  const close = () => {
    if (taskId) boardMemory.focusTaskId = taskId;
    back();
  };

  const onDragStart = (e: DragStartEvent) =>
    setActiveId(String(e.active.id).slice(TASK_PREFIX.length));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const id = String(e.active.id).slice(TASK_PREFIX.length);
    const task = tasks[id];
    if (!task || !e.over) return;
    const target = stateOfOver(String(e.over.id), tasks);
    if (!target || target.beforeId === id) return;
    const column = board.columns[target.state];
    const position = positionFor(column, target.beforeId, id);
    if (target.state === task.state) {
      if (board.filters.sort === "priority") void mover.reorder(task, position);
      return;
    }
    void mover.move(task, target.state, { position });
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id, tasks)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${titleOf(active.id, tasks)} is over ${describeOver(String(over.id), tasks)}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${titleOf(active.id, tasks)} on ${describeOver(String(over.id), tasks)}.`
        : `Dropped ${titleOf(active.id, tasks)}. It did not move.`,
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id, tasks)} was canceled.`,
  };

  const activeTask = activeId ? tasks[activeId] : undefined;
  const drawerTask = taskId ? tasks[taskId] : undefined;
  const noProjects = hydrated && Object.keys(projects).length === 0;

  return (
    <div data-testid="board" className="absolute inset-0 flex min-w-0 flex-col">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="mr-2 text-lg font-semibold">Board</h1>
        <ProjectSelect board={board} />
        <SearchBox board={board} className="w-56 max-w-full" />
        <FilterButton board={board} />
        <div className="ml-auto">
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setNewOpen(true)}
            disabled={noProjects}
            title={noProjects ? "Add a project first" : undefined}
          >
            New task
          </Button>
        </div>
      </header>
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2">
        <DispatchToggle />
        <span className="text-sm text-muted" role="status">
          {board.queueCount} queued
        </span>
        <SortSelect board={board} />
        <CompletedToggle board={board} />
        <FilterChips board={board} />
      </div>
      <BoardNotices board={board} />

      {!hydrated ? (
        <LoadingState label="Loading tasks…" />
      ) : noProjects ? (
        <EmptyState
          icon={<SquareKanban className="size-8" />}
          title="No projects yet"
          description="Tasks belong to a project. Add a project from a host checkout to start planning work."
          action={{ label: "Add a project", to: ROUTES.settings("projects") }}
        />
      ) : board.totalTasks === 0 ? (
        <EmptyState
          icon={<SquareKanban className="size-8" />}
          title="No tasks yet"
          description="Create a task in Backlog, or make it ready so the dispatcher starts it."
          action={{ label: "New task", onClick: () => setNewOpen(true) }}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "To move a task, press Space to pick it up, use the arrow keys to move between columns, then press Space to drop or Escape to cancel. The task menu offers Move to… without dragging.",
            },
          }}
        >
          {board.visibleCount === 0 && (
            <p role="status" className="px-4 pt-3 text-sm text-muted">
              No tasks match the filters.{" "}
              <button
                type="button"
                className="tap font-medium text-accent"
                onClick={() => board.setFilters({ ...DEFAULT_FILTERS, sort: board.filters.sort })}
              >
                Clear filters
              </button>
            </p>
          )}
          <section
            ref={scrollerRef}
            aria-label="Board columns"
            onScroll={(e) => {
              boardMemory.boardScrollLeft = e.currentTarget.scrollLeft;
            }}
            className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <div className="flex h-full w-max gap-3 p-4">
              {board.states.map((state) => (
                <Column
                  key={state}
                  state={state}
                  board={board}
                  width={colWidth}
                  onOpen={open}
                  selectedId={taskId}
                  onNew={() => setNewOpen(true)}
                />
              ))}
            </div>
          </section>
          <DragOverlay dropAnimation={null}>
            {activeTask && (
              <div
                className="rotate-1 shadow-pop"
                style={{ width: `clamp(272px, ${colWidth - 16}px, 344px)` }}
              >
                <TaskCard
                  task={activeTask}
                  showProject={board.showProject}
                  wait={board.waits.get(activeTask.id)}
                  onOpen={() => undefined}
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      <Drawer
        open={!!taskId}
        onClose={close}
        width={520}
        title={drawerTask?.title ?? (hydrated ? "Task not found" : "Loading task…")}
        description={drawerTask ? STATE_LABELS[drawerTask.state] : undefined}
        footer={drawerTask ? <DrawerFooter task={drawerTask} /> : undefined}
      >
        <div data-testid="task-drawer" className="min-w-0">
          {drawerTask ? (
            <TaskDetailBody
              task={drawerTask}
              onDeleted={() => navigate(ROUTES.board, { replace: true })}
            />
          ) : hydrated ? (
            <EmptyState
              title="Task not found"
              description="It may have been deleted, or this link is from another coordinator."
              action={{ label: "Back to board", to: ROUTES.board }}
            />
          ) : (
            <LoadingState label="Loading task…" />
          )}
        </div>
      </Drawer>

      <Dialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New task"
        className="max-w-xl"
      >
        <NewTaskForm
          defaultProjectId={board.projectId}
          onCancel={() => setNewOpen(false)}
          onCreated={(t) => {
            setNewOpen(false);
            boardMemory.focusTaskId = t.id;
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>(`[data-card-open="${CSS.escape(t.id)}"]`)
                ?.focus(),
            );
          }}
        />
      </Dialog>
    </div>
  );
}

function DrawerFooter({ task }: { task: Task }) {
  const { eligibility } = useEligibility(task);
  return (
    <div className="w-full min-w-0">
      <PrimaryAction task={task} eligibility={eligibility} />
    </div>
  );
}

function titleOf(id: string | number, tasks: Record<string, Task>): string {
  const t = tasks[String(id).replace(TASK_PREFIX, "")];
  return t ? `task ${t.title}` : "task";
}

function describeOver(id: string, tasks: Record<string, Task>): string {
  if (id.startsWith(COL_PREFIX))
    return `the ${STATE_LABELS[id.slice(COL_PREFIX.length) as TaskState]} column`;
  const t = tasks[id.slice(CARD_PREFIX.length)];
  return t ? `${t.title} in ${STATE_LABELS[t.state]}` : "a task";
}

function Column({
  state,
  board,
  width,
  onOpen,
  selectedId,
  onNew,
}: {
  state: TaskState;
  board: BoardState;
  width: number;
  onOpen: (t: Task) => void;
  selectedId?: string;
  onNew: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL_PREFIX}${state}` });
  const [revealDone, setRevealDone] = useState(false);
  const tasks = board.columns[state];
  const Icon = TASK_STATUS[state].icon;
  const hideDone = state === "done" && !board.filters.showCompleted && !revealDone;
  const headingId = `col-${state}-title`;
  const restoreColumnScroll = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.scrollTop = boardMemory.columnScroll[state] ?? 0;
    },
    [state],
  );
  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${state}`}
      aria-labelledby={headingId}
      style={{ width: `clamp(288px, ${width}px, 360px)` }}
      className={`flex h-full shrink-0 flex-col rounded-lg border bg-surface-2 ${isOver ? "border-accent" : "border-border"}`}
    >
      <div
        ref={restoreColumnScroll}
        data-column-scroll={state}
        onScroll={(e) => {
          boardMemory.columnScroll[state] = e.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
      >
        <h2
          id={headingId}
          className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        >
          <Icon aria-hidden className="size-4 text-muted" />
          <span className="flex-1">{STATE_LABELS[state]}</span>
          <span className="rounded-full bg-surface px-2 text-xs font-medium text-muted tabular-nums">
            {tasks.length}
            <span className="sr-only"> tasks</span>
          </span>
        </h2>
        <ul className="flex flex-col gap-2 p-2">
          {hideDone ? (
            <li className="flex flex-col items-start gap-1 px-1 py-2 text-sm text-muted">
              {tasks.length} completed {tasks.length === 1 ? "task is" : "tasks are"} hidden.
              {tasks.length > 0 && (
                <button
                  type="button"
                  className="tap font-medium text-accent"
                  onClick={() => setRevealDone(true)}
                >
                  Show completed
                </button>
              )}
            </li>
          ) : tasks.length === 0 ? (
            <li className="px-1 py-2 text-sm text-muted">
              {state === "backlog" ? (
                <button
                  type="button"
                  className="tap inline-flex items-center gap-1 font-medium text-accent"
                  onClick={onNew}
                >
                  <Plus aria-hidden className="size-4" /> New task
                </button>
              ) : (
                "No tasks"
              )}
            </li>
          ) : (
            tasks.map((t) => (
              <li key={t.id}>
                <DraggableCard
                  task={t}
                  board={board}
                  onOpen={onOpen}
                  selected={t.id === selectedId}
                />
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}

function DraggableCard({
  task,
  board,
  onOpen,
  selected,
}: {
  task: Task;
  board: BoardState;
  onOpen: (t: Task) => void;
  selected: boolean;
}) {
  const drag = useDraggable({ id: `${TASK_PREFIX}${task.id}` });
  const drop = useDroppable({ id: `${CARD_PREFIX}${task.id}`, disabled: drag.isDragging });
  const { onPointerDown, onKeyDown } = (drag.listeners ?? {}) as {
    onPointerDown?: React.PointerEventHandler<HTMLElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  };
  const bindings: DragBindings = {
    setNodeRef: (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      drop.setNodeRef(el);
    },
    setHandleRef: drag.setActivatorNodeRef,
    cardProps: { onPointerDown },
    handleProps: { ...drag.attributes, onKeyDown },
    dragging: drag.isDragging,
    style: drop.isOver ? { boxShadow: "0 -3px 0 0 var(--sy-accent)" } : undefined,
  };
  return (
    <TaskCard
      task={task}
      showProject={board.showProject}
      wait={board.waits.get(task.id)}
      onOpen={onOpen}
      drag={bindings}
      selected={selected}
    />
  );
}
