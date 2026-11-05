import type { Task, TaskState } from "@switchyard/protocol";
import { ArrowLeft, ArrowRightLeft, Columns3, List, Plus, SquareKanban } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useHideBottomNav } from "../../app/chrome";
import { ROUTES } from "../../app/routes";
import { BACK_STATE, useBackTo } from "../../app/useBackTo";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Sheet } from "../../components/ui/Overlay";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { TASK_STATUS } from "../../components/ui/StatusChip";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { useFilter } from "../../prefs";
import { useSyncStore, useTask } from "../../sync/store";
import {
  BoardNotices,
  DispatchToggle,
  FilterButton,
  FilterChips,
  ProjectSelect,
  SearchBox,
} from "./BoardChrome";
import { DEFAULT_FILTERS, moveTargets, planMove, STATE_LABELS } from "./logic";
import { useTaskMover } from "./MoveProvider";
import { NewTaskForm } from "./NewTaskForm";
import { moveLabel, StateIcon, TaskCard } from "./TaskCard";
import { PrimaryAction, TaskDetailBody, useEligibility } from "./TaskDetail";
import { boardMemory, useBoard } from "./useBoard";

interface MobilePrefs {
  tab: TaskState;
  layout: "column" | "list";
}

const mainEl = () => document.getElementById("main");

/** Mobile board: one status at a time with scrollable tabs, or a grouped list. No drag-and-drop. */
export function BoardMobile() {
  const board = useBoard();
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const navigate = useNavigate();
  const [prefs, setPrefs] = useFilter<MobilePrefs>("board-mobile", {
    tab: "ready",
    layout: "column",
  });
  const [newOpen, setNewOpen] = useState(false);
  const tab = board.states.includes(prefs.tab) ? prefs.tab : "ready";

  // Restore the vertical position when coming back from task detail.
  useLayoutEffect(() => {
    if (!hydrated) return;
    const el = mainEl();
    const target = boardMemory.mainScrollTop;
    if (el) el.scrollTop = target;
    // The bottom nav (hidden by the task detail) comes back a moment later and shortens #main,
    // so a position near the end was clamped: apply it again once the layout settled.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        if (el && el.scrollTop < target) el.scrollTop = target;
      });
    });
    const focusId = boardMemory.focusTaskId;
    boardMemory.focusTaskId = null;
    if (focusId)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-card-open="${CSS.escape(focusId)}"]`)
          ?.focus({ preventScroll: true }),
      );
    return () => cancelAnimationFrame(raf);
  }, [hydrated]);

  const open = (t: Task) => {
    boardMemory.mainScrollTop = mainEl()?.scrollTop ?? 0;
    boardMemory.focusTaskId = t.id;
    navigate(ROUTES.task(t.id), { state: BACK_STATE });
  };

  const noProjects = hydrated && Object.keys(projects).length === 0;
  const renderList = (tasks: Task[], state: TaskState) =>
    tasks.length === 0 ? (
      <p className="px-1 py-3 text-sm text-muted">No {STATE_LABELS[state]} tasks.</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <TaskCard
              task={t}
              full
              showProject={board.showProject}
              wait={board.waits.get(t.id)}
              onOpen={open}
            />
          </li>
        ))}
      </ul>
    );

  return (
    <div data-testid="board" className="flex min-w-0 flex-col">
      <header className="flex min-w-0 flex-col gap-2 border-b border-border bg-bg px-3 pb-0 safe-pt-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-lg font-semibold">Board</h1>
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setNewOpen(true)}
            disabled={noProjects}
          >
            New task
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <ProjectSelect board={board} className="min-w-0 flex-1" />
          <FilterButton board={board} mobile />
        </div>
        <SearchBox board={board} />
        <FilterChips board={board} />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <DispatchToggle compact />
          <span className="text-sm text-muted">{board.queueCount} queued</span>
        </div>
        <SegmentedControl
          label="Board layout"
          block
          value={prefs.layout}
          onChange={(layout) => setPrefs({ ...prefs, layout })}
          options={[
            {
              value: "column",
              label: "Columns",
              icon: <Columns3 aria-hidden className="size-4" />,
            },
            { value: "list", label: "List", icon: <List aria-hidden className="size-4" /> },
          ]}
        />
        {prefs.layout === "column" && (
          <div data-testid="status-tabs" className="-mx-3 px-1">
            <Tabs
              label="Task status"
              idPrefix="board-tab"
              scrollable
              className="border-b-0"
              value={tab}
              onChange={(id) => setPrefs({ ...prefs, tab: id as TaskState })}
              tabs={board.states.map((s) => {
                const Icon = TASK_STATUS[s].icon;
                return {
                  id: s,
                  label: (
                    <>
                      <Icon aria-hidden className="size-4" />
                      {STATE_LABELS[s]}
                    </>
                  ),
                  badge: (
                    <Badge label={`${board.columns[s].length} tasks`}>
                      {board.columns[s].length}
                    </Badge>
                  ),
                };
              })}
            />
          </div>
        )}
      </header>
      <BoardNotices board={board} />

      <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
        {!hydrated ? (
          <LoadingState label="Loading tasks…" />
        ) : noProjects ? (
          <EmptyState
            icon={<SquareKanban className="size-8" />}
            title="No projects yet"
            description="Tasks belong to a project. Add a project from a host checkout first."
            action={{ label: "Add a project", to: ROUTES.settings("projects") }}
          />
        ) : board.totalTasks === 0 ? (
          <EmptyState
            icon={<SquareKanban className="size-8" />}
            title="No tasks yet"
            description="Create a task in Backlog, or make it ready so the dispatcher starts it."
            action={{ label: "New task", onClick: () => setNewOpen(true) }}
          />
        ) : board.visibleCount === 0 ? (
          <EmptyState
            title="No tasks match the filters"
            action={{
              label: "Clear filters",
              onClick: () => board.setFilters({ ...DEFAULT_FILTERS, sort: board.filters.sort }),
            }}
          />
        ) : prefs.layout === "column" ? (
          <TabPanel idPrefix="board-tab" id={tab}>
            {tab === "done" && !board.filters.showCompleted ? (
              <p className="text-sm text-muted">
                Completed tasks are hidden.{" "}
                <button
                  type="button"
                  className="tap font-medium text-accent"
                  onClick={() => board.setFilters({ ...board.filters, showCompleted: true })}
                >
                  Show completed
                </button>
              </p>
            ) : (
              renderList(board.columns[tab], tab)
            )}
          </TabPanel>
        ) : (
          board.states
            .filter((s) => s !== "done" || board.filters.showCompleted)
            .map((s) => (
              <section
                key={s}
                aria-labelledby={`grp-${s}`}
                data-testid={`column-${s}`}
                className="flex flex-col gap-2"
              >
                <h2 id={`grp-${s}`} className="flex items-center gap-2 pt-1 text-sm font-semibold">
                  <StateIcon state={s} className="text-muted" />
                  {STATE_LABELS[s]}
                  <span className="text-muted">({board.columns[s].length})</span>
                </h2>
                {renderList(board.columns[s], s)}
              </section>
            ))
        )}
      </div>

      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="New task">
        <NewTaskForm
          defaultProjectId={board.projectId}
          onCancel={() => setNewOpen(false)}
          onCreated={(t) => {
            setNewOpen(false);
            setPrefs({ ...prefs, tab: t.state });
          }}
        />
      </Sheet>
    </div>
  );
}

/** Mobile full-screen task detail (/tasks/:taskId). Back returns to the board position. */
export function TaskDetailPage({ taskId }: { taskId: string }) {
  useHideBottomNav();
  const task = useTask(taskId);
  const hydrated = useSyncStore((s) => s.hydrated);
  const [moveOpen, setMoveOpen] = useState(false);
  const { eligibility } = useEligibility(task);
  const back = useBackTo(ROUTES.board);

  useLayoutEffect(() => {
    const el = mainEl();
    if (el) el.scrollTop = 0;
  }, []);

  return (
    <div className="flex min-w-0 flex-col" data-testid="task-page">
      <header className="sticky top-0 z-20 flex min-w-0 items-center gap-1 border-b border-border bg-surface px-1 pb-1 safe-pt-1">
        <IconButton label="Back to board" icon={<ArrowLeft className="size-5" />} onClick={back} />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{task?.title ?? "Task"}</h1>
        {task && (
          <Button
            size="sm"
            icon={<ArrowRightLeft className="size-4" />}
            onClick={() => setMoveOpen(true)}
          >
            Move task
          </Button>
        )}
      </header>
      {!task ? (
        hydrated ? (
          <EmptyState
            title="Task not found"
            description="It may have been deleted."
            action={{ label: "Back to board", to: ROUTES.board }}
          />
        ) : (
          <LoadingState label="Loading task…" />
        )
      ) : (
        <div className="flex min-w-0 flex-col px-4 pt-3 pb-8">
          <div>
            <PrimaryAction task={task} eligibility={eligibility} block />
          </div>
          <TaskDetailBody task={task} onDeleted={back} />
          <MoveSheet task={task} open={moveOpen} onClose={() => setMoveOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Action sheet with every valid destination state (and why some need a decision). */
export function MoveSheet({
  task,
  open,
  onClose,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
}) {
  const mover = useTaskMover();
  const runs = useSyncStore((s) => s.runs);
  const run = task.currentRunId ? runs[task.currentRunId] : undefined;
  const all: TaskState[] = ["backlog", "ready", "in_progress", "review", "done", "canceled"];
  const valid = new Set(moveTargets(task));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Move task"
      description={`Currently ${STATE_LABELS[task.state]}`}
    >
      <ul data-testid="move-sheet" className="flex flex-col">
        {all
          .filter((s) => s !== task.state)
          .map((s) => {
            const plan = planMove(task, s, run);
            const hint =
              plan.kind === "invalid"
                ? plan.reason
                : plan.kind === "choose_running"
                  ? "Asks whether to pause automation or stop execution."
                  : plan.kind === "confirm_done"
                    ? "Asks you to confirm acceptance."
                    : plan.kind === "run_now"
                      ? "Starts now if the task is eligible."
                      : null;
            return (
              <li key={s}>
                <button
                  type="button"
                  disabled={!valid.has(s)}
                  onClick={() => {
                    onClose();
                    void mover.move(task, s);
                  }}
                  className="tap flex w-full items-start gap-3 rounded-md px-2 py-3 text-left hover:bg-surface-2 disabled:opacity-60"
                >
                  <StateIcon state={s} className="mt-0.5 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{moveLabel(task.state, s)}</span>
                    {hint && <span className="block text-sm text-muted">{hint}</span>}
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </Sheet>
  );
}
