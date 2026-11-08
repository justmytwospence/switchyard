import type { Eligibility, TaskState } from "@switchyard/protocol";
import { useMemo } from "react";
import { usePrefs } from "../../prefs";
import { useSyncStore } from "../../sync/store";
import { useNow } from "../queue/useNow";
import {
  type BoardFilters,
  type BoardTaskNode,
  buildColumns,
  buildColumnTree,
  type ChildProgress,
  type Columns,
  childProgress,
  normalizeFilters,
  openAttentionByTask,
  visibleColumns,
} from "./logic";

export interface BoardState {
  filters: BoardFilters;
  setFilters: (f: BoardFilters) => void;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  columns: Columns;
  trees: Record<TaskState, BoardTaskNode[]>;
  childProgress: Map<string, ChildProgress>;
  states: TaskState[];
  /** Wait reason per queued task id (from /api/now). */
  waits: Map<string, Eligibility>;
  queueCount: number;
  now: ReturnType<typeof useNow>;
  showProject: boolean;
  totalTasks: number;
  visibleCount: number;
}

/** Board data shared by the desktop and mobile layouts. Filters and project persist per device. */
export function useBoard(): BoardState {
  const raw = usePrefs((s) => s.filters.board);
  const setFilter = usePrefs((s) => s.setFilter);
  const projectId = usePrefs((s) => s.selectedProjectId);
  const setPref = usePrefs((s) => s.set);
  const filters = useMemo(() => normalizeFilters(raw), [raw]);
  const tasks = useSyncStore((s) => s.tasks);
  const runs = useSyncStore((s) => s.runs);
  const attention = useSyncStore((s) => s.attention);
  const projects = useSyncStore((s) => s.projects);
  const now = useNow();

  const validProject = projectId && projects[projectId] ? projectId : null;

  const columns = useMemo(() => {
    const attentionTaskIds = new Set(openAttentionByTask(attention).keys());
    return buildColumns(tasks, filters, { projectId: validProject, runs, attentionTaskIds });
  }, [tasks, filters, validProject, runs, attention]);

  const hierarchy = useMemo(() => {
    // Do not apply board filters here: hidden/completed/canceled children still count.
    const allTasks = Object.fromEntries(
      Object.entries(tasks).filter(([, t]) => !validProject || t.projectId === validProject),
    );
    const trees = {} as Record<TaskState, BoardTaskNode[]>;
    for (const state of Object.keys(columns) as TaskState[])
      trees[state] = buildColumnTree(columns[state], allTasks);
    const progress = new Map<string, ChildProgress>();
    const parentIds = new Set(Object.values(allTasks).map((t) => t.parentTaskId));
    for (const id of parentIds) if (id) progress.set(id, childProgress(id, allTasks));
    return { trees, progress };
  }, [tasks, validProject, columns]);

  const waits = useMemo(() => {
    const m = new Map<string, Eligibility>();
    for (const q of now.data?.queued ?? []) m.set(q.taskId, q.eligibility);
    return m;
  }, [now.data]);

  const queueCount = useMemo(() => {
    if (now.data)
      return now.data.queued.filter(
        (q) => !validProject || tasks[q.taskId]?.projectId === validProject,
      ).length;
    return Object.values(tasks).filter(
      (t) =>
        t.state === "ready" &&
        !t.hiddenFromBoard &&
        (!validProject || t.projectId === validProject),
    ).length;
  }, [now.data, tasks, validProject]);

  const states = visibleColumns(filters);
  const totalTasks = useMemo(
    () =>
      Object.values(tasks).filter(
        (t) => !t.hiddenFromBoard && (!validProject || t.projectId === validProject),
      ).length,
    [tasks, validProject],
  );
  const visibleCount = states.reduce((n, s) => n + columns[s].length, 0);

  return {
    filters,
    setFilters: (f) => setFilter("board", f),
    projectId: validProject,
    setProjectId: (id) => setPref("selectedProjectId", id),
    columns,
    trees: hierarchy.trees,
    childProgress: hierarchy.progress,
    states,
    waits,
    queueCount,
    now,
    showProject: !validProject && Object.keys(projects).length > 1,
    totalTasks,
    visibleCount,
  };
}

/** Board scroll/tab position kept across task detail navigation (module memory, per page load). */
export const boardMemory: {
  mainScrollTop: number;
  boardScrollLeft: number;
  columnScroll: Partial<Record<TaskState, number>>;
  focusTaskId: string | null;
} = { mainScrollTop: 0, boardScrollLeft: 0, columnScroll: {}, focusTaskId: null };
