import type {
  AttentionItem,
  Eligibility,
  Host,
  Priority,
  Project,
  Run,
  Task,
  TaskState,
} from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";

/**
 * Pure board helpers (filters, sorting, move planning, eligibility wording).
 * Kept free of React so they are unit-testable.
 */

export const BOARD_COLUMNS: TaskState[] = ["backlog", "ready", "in_progress", "review", "done"];

export const STATE_LABELS: Record<TaskState, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  canceled: "Canceled",
};

export type BoardSort = "priority" | "updated" | "created";

export interface BoardFilters {
  search: string;
  priorities: Priority[];
  hostId: string | null;
  attentionOnly: boolean;
  blockedOnly: boolean;
  showCanceled: boolean;
  showCompleted: boolean;
  sort: BoardSort;
}

export const DEFAULT_FILTERS: BoardFilters = {
  search: "",
  priorities: [],
  hostId: null,
  attentionOnly: false,
  blockedOnly: false,
  showCanceled: false,
  showCompleted: true,
  sort: "priority",
};

export function normalizeFilters(raw: unknown): BoardFilters {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<BoardFilters>;
  return {
    search: typeof v.search === "string" ? v.search : "",
    priorities: Array.isArray(v.priorities)
      ? (v.priorities.filter((p) => [0, 1, 2, 3].includes(p as number)) as Priority[])
      : [],
    hostId: typeof v.hostId === "string" ? v.hostId : null,
    attentionOnly: v.attentionOnly === true,
    blockedOnly: v.blockedOnly === true,
    showCanceled: v.showCanceled === true,
    showCompleted: v.showCompleted !== false,
    sort: v.sort === "updated" || v.sort === "created" ? v.sort : "priority",
  };
}

export interface ActiveFilterChip {
  key: string;
  label: string;
  clear: (f: BoardFilters) => BoardFilters;
}

/** Removable chips for every non-default filter (search shown separately on desktop). */
export function activeFilterChips(
  f: BoardFilters,
  hostName: (id: string) => string,
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (f.search.trim())
    chips.push({
      key: "search",
      label: `Search: ${f.search.trim()}`,
      clear: (x) => ({ ...x, search: "" }),
    });
  for (const p of f.priorities)
    chips.push({
      key: `priority-${p}`,
      label: `Priority: ${PRIORITY_LABELS[p]}`,
      clear: (x) => ({ ...x, priorities: x.priorities.filter((q) => q !== p) }),
    });
  if (f.hostId)
    chips.push({
      key: "host",
      label: `Host: ${hostName(f.hostId)}`,
      clear: (x) => ({ ...x, hostId: null }),
    });
  if (f.attentionOnly)
    chips.push({
      key: "attention",
      label: "Needs attention",
      clear: (x) => ({ ...x, attentionOnly: false }),
    });
  if (f.blockedOnly)
    chips.push({ key: "blocked", label: "Blocked", clear: (x) => ({ ...x, blockedOnly: false }) });
  if (f.showCanceled)
    chips.push({
      key: "canceled",
      label: "Including canceled",
      clear: (x) => ({ ...x, showCanceled: false }),
    });
  return chips;
}

export interface FilterContext {
  projectId: string | null;
  runs: Record<string, Run>;
  /** Task ids with open attention. */
  attentionTaskIds: Set<string>;
}

/** The host a task runs (or will run) on: current run, explicit policy, or nothing. */
export function taskHostId(task: Task, runs: Record<string, Run>): string | null {
  const run = task.currentRunId ? runs[task.currentRunId] : undefined;
  return run?.hostId ?? task.policy.hostId ?? null;
}

export function matchesFilters(task: Task, f: BoardFilters, ctx: FilterContext): boolean {
  if (task.hiddenFromBoard) return false;
  if (ctx.projectId && task.projectId !== ctx.projectId) return false;
  if (task.state === "canceled" && !f.showCanceled) return false;
  const q = f.search.trim().toLowerCase();
  if (q && !`${task.title}\n${task.objective}`.toLowerCase().includes(q)) return false;
  if (f.priorities.length > 0 && !f.priorities.includes(task.priority)) return false;
  if (f.hostId && taskHostId(task, ctx.runs) !== f.hostId) return false;
  if (f.attentionOnly && !ctx.attentionTaskIds.has(task.id)) return false;
  if (f.blockedOnly && !task.blocked) return false;
  return true;
}

export function sortTasks(tasks: Task[], sort: BoardSort): Task[] {
  const out = [...tasks];
  if (sort === "updated") out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  else if (sort === "created") out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else
    out.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.position - b.position ||
        a.createdAt.localeCompare(b.createdAt),
    );
  return out;
}

export type Columns = Record<TaskState, Task[]>;

export function buildColumns(
  tasks: Record<string, Task>,
  f: BoardFilters,
  ctx: FilterContext,
): Columns {
  const out: Columns = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
    canceled: [],
  };
  for (const t of Object.values(tasks)) if (matchesFilters(t, f, ctx)) out[t.state].push(t);
  for (const k of Object.keys(out) as TaskState[]) out[k] = sortTasks(out[k], f.sort);
  return out;
}

export interface ChildProgress {
  done: number;
  total: number;
  canceled: number;
}

/** All direct children count, including hidden, filtered and canceled tasks. */
export function childProgress(parentId: string, allTasks: Record<string, Task>): ChildProgress {
  const progress = { done: 0, total: 0, canceled: 0 };
  const parent = allTasks[parentId];
  for (const task of Object.values(allTasks)) {
    if (task.parentTaskId !== parentId || task.id === parentId) continue;
    if (parent && task.projectId !== parent.projectId) continue;
    progress.total++;
    if (task.state === "done") progress.done++;
    if (task.state === "canceled") progress.canceled++;
  }
  return progress;
}

/** Root-first full ancestry, independent of board filters and state. Tolerates corrupt cycles. */
export function taskAncestors(task: Task, allTasks: Record<string, Task>): Task[] {
  const ancestors: Task[] = [];
  const seen = new Set([task.id]);
  let parentId = task.parentTaskId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = allTasks[parentId];
    if (!parent || parent.projectId !== task.projectId) break;
    ancestors.push(parent);
    parentId = parent.parentTaskId;
  }
  return ancestors.reverse();
}

export interface BoardTaskNode {
  task: Task;
  children: BoardTaskNode[];
  /** Visible nesting depth; a parent in another column does not indent this row. */
  depth: number;
  /** Full ancestry for accessible labels, even when ancestors are filtered out. */
  ancestors: Task[];
}

/** Display-only tree. Never changes flat columns, counts, or drag/reorder positions. */
export function buildColumnTree(column: Task[], allTasks: Record<string, Task>): BoardTaskNode[] {
  const nodes = new Map<string, BoardTaskNode>();
  for (const task of column) {
    nodes.set(task.id, { task, children: [], depth: 0, ancestors: taskAncestors(task, allTasks) });
  }
  const parents = new Map<string, string>();
  for (const task of column) {
    const parent = task.parentTaskId ? nodes.get(task.parentTaskId)?.task : undefined;
    if (parent && parent.projectId === task.projectId && parent.state === task.state)
      parents.set(task.id, parent.id);
  }
  // Break one edge per cycle, deterministically in flat-column order. No row is lost.
  const checked = new Set<string>();
  for (const task of column) {
    const path = new Set<string>();
    let id: string | undefined = task.id;
    while (id && !checked.has(id)) {
      if (path.has(id)) {
        parents.delete(id);
        break;
      }
      path.add(id);
      id = parents.get(id);
    }
    for (const visited of path) checked.add(visited);
  }
  const roots: BoardTaskNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parents.get(node.task.id);
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    for (const child of node.children) {
      child.depth = node.depth + 1;
      pending.push(child);
    }
  }
  return roots;
}

/** Preorder rows keep each card (not its subtree) an independent drag/drop target. */
export function columnTreeRows(tree: BoardTaskNode[]): BoardTaskNode[] {
  const rows: BoardTaskNode[] = [];
  const pending = [...tree].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    rows.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]!);
  }
  return rows;
}

/** Parent selection is separate from dependencies; descendants cannot become parents. */
export function parentCandidates(
  projectId: string,
  allTasks: Record<string, Task>,
  taskId?: string,
): Task[] {
  return Object.values(allTasks)
    .filter(
      (task) =>
        task.projectId === projectId &&
        task.id !== taskId &&
        (!taskId || !taskAncestors(task, allTasks).some((ancestor) => ancestor.id === taskId)),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function visibleColumns(f: BoardFilters): TaskState[] {
  return f.showCanceled ? [...BOARD_COLUMNS, "canceled"] : BOARD_COLUMNS;
}

/* ------------------------------------------------------------------ */
/* Move planning                                                       */
/* ------------------------------------------------------------------ */

/** Client mirror of the coordinator's transition table (plans: tasks/state.ts). */
export const TRANSITIONS: Record<TaskState, TaskState[]> = {
  backlog: ["ready", "canceled"],
  ready: ["backlog", "in_progress", "canceled"],
  in_progress: ["review", "ready", "backlog", "canceled", "done"],
  review: ["in_progress", "done", "ready", "canceled"],
  done: ["ready", "backlog"],
  canceled: ["backlog"],
};

export type MovePlan =
  | { kind: "noop" }
  | { kind: "invalid"; reason: string }
  /** Plain move (POST /move). */
  | { kind: "move" }
  /** Ready to In progress means "Run now" (dispatcher only). */
  | { kind: "run_now" }
  /** Review to In progress starts a new attempt. */
  | { kind: "new_attempt" }
  /** Running work moved backward: the user chooses pause automation or stop execution. */
  | { kind: "choose_running" }
  /** Moving to Done with unresolved criteria/checks: confirm acceptance. */
  | { kind: "confirm_done"; reasons: string[] };

/** True while a run is live (dispatching, running, waiting, checking). */
export function isRunActive(run: Run | undefined | null): boolean {
  return (
    !!run &&
    ["queued", "dispatching", "uncertain", "running", "waiting_input", "checking"].includes(
      run.state,
    )
  );
}

/** Why moving to Done needs explicit acceptance; empty when nothing is unresolved. */
export function unresolvedForDone(task: Task, run: Run | undefined | null): string[] {
  const reasons: string[] = [];
  if (task.state !== "review") reasons.push("The task has not been through review.");
  if (task.acceptanceCriteria.length > 0)
    reasons.push(
      `${task.acceptanceCriteria.length} acceptance ${
        task.acceptanceCriteria.length === 1 ? "criterion has" : "criteria have"
      } not been confirmed.`,
    );
  const checksRequired = (task.policy.completion.checks?.length ?? 0) > 0;
  const failing = run?.checks.filter((c) => c.exitCode !== 0) ?? [];
  if (failing.length > 0)
    reasons.push(`Checks failing: ${failing.map((c) => c.command).join(", ")}.`);
  else if (checksRequired && (!run || run.checks.length === 0))
    reasons.push("Required checks have not run.");
  if (task.policy.completion.requireHumanReview && task.state === "review")
    reasons.push("Human review is required: moving to Done accepts the work.");
  return reasons;
}

export const ALL_STATES: TaskState[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "canceled",
];

/** Short explanation under a move target: why it is blocked, or what choice it asks for. */
export function moveHint(plan: MovePlan): string | null {
  switch (plan.kind) {
    case "invalid":
      return plan.reason;
    case "choose_running":
      return "Asks whether to pause automation or stop execution.";
    case "confirm_done":
      return "Asks you to confirm acceptance.";
    case "run_now":
      return "Starts now if the task is eligible.";
    default:
      return null;
  }
}

export function planMove(task: Task, to: TaskState, run?: Run | null): MovePlan {
  if (task.state === to) return { kind: "noop" };
  const from = task.state;
  if (!TRANSITIONS[from].includes(to)) {
    return { kind: "invalid", reason: invalidReason(from, to) };
  }
  if (from === "ready" && to === "in_progress") return { kind: "run_now" };
  if (from === "review" && to === "in_progress") return { kind: "new_attempt" };
  if (from === "in_progress" && (to === "ready" || to === "backlog")) {
    return { kind: "choose_running" };
  }
  if (to === "done") {
    const reasons = unresolvedForDone(task, run);
    if (reasons.length > 0) return { kind: "confirm_done", reasons };
  }
  return { kind: "move" };
}

function invalidReason(from: TaskState, to: TaskState): string {
  const f = STATE_LABELS[from];
  const t = STATE_LABELS[to];
  if (to === "in_progress")
    return from === "backlog"
      ? "A Backlog task cannot start directly. Move it to Ready first; the dispatcher starts it when it is eligible."
      : `${f} tasks cannot be moved to In progress. Only the dispatcher starts work (Run now from Ready).`;
  if (to === "review")
    return "Only a finished run moves a task to Review. Run the task, or use Done to accept it.";
  if (from === "canceled") return "A canceled task can only be restored to Backlog.";
  if (from === "done" && to === "canceled")
    return "A Done task cannot be canceled. Reopen it first.";
  if (from === "backlog" && to === "done")
    return "A Backlog task cannot be marked Done. Make it ready and review its work first.";
  if (from === "ready" && to === "done")
    return "A task that has not run cannot be marked Done. Run it, or cancel it.";
  return `Moving from ${f} to ${t} is not allowed.`;
}

/** Valid targets for "Move to…" menus, excluding the current state. */
export function moveTargets(task: Task): TaskState[] {
  return TRANSITIONS[task.state];
}

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

/** Position that places a card before `beforeId` (or at the end) in a sorted column. */
export function positionFor(column: Task[], beforeId: string | null, movingId: string): number {
  const list = column.filter((t) => t.id !== movingId);
  if (list.length === 0) return 1;
  if (beforeId === null) return list[list.length - 1]!.position + 1;
  const idx = list.findIndex((t) => t.id === beforeId);
  if (idx < 0) return list[list.length - 1]!.position + 1;
  const next = list[idx]!.position;
  const prev = idx > 0 ? list[idx - 1]!.position : next - 2;
  return (prev + next) / 2;
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

export type WaitReason = Extract<Eligibility, { eligible: false }>["wait"];

export const WAIT_LABELS: Record<WaitReason, string> = {
  dependency: "Waiting on dependencies",
  host_offline: "Host offline",
  project_limit: "Project run limit reached",
  workspace_occupied: "Workspace occupied",
  scheduled_time: "Scheduled for later",
  invalid_configuration: "Invalid configuration",
  dispatch_paused: "Dispatch paused",
  project_automation_disabled: "Auto-start is off for this project",
  not_ready: "Not ready",
  already_dispatched: "Already dispatched",
  retry_backoff: "Retrying after a failure",
};

export function eligibilityText(e: Eligibility): string {
  if (e.eligible) return `Will start automatically on ${e.hostName}`;
  return `Will wait: ${e.message || WAIT_LABELS[e.wait]}`;
}

export interface PreviewInput {
  project: Project | undefined;
  hostId: string | null;
  dependencies: string[];
  notBefore?: string | null;
}

export interface PreviewState {
  hosts: Record<string, Host>;
  tasks: Record<string, Task>;
  dispatchPaused: boolean;
  /** Tasks currently running per project (for the project limit). */
  runningByProject: Record<string, number>;
}

/**
 * Client-side eligibility estimate for a task that does not exist yet (or
 * when the coordinator returns `not_ready` for a Backlog task). The
 * coordinator's dispatcher stays authoritative.
 */
export function previewEligibility(input: PreviewInput, state: PreviewState): Eligibility {
  const { project } = input;
  if (!project)
    return { eligible: false, wait: "invalid_configuration", message: "Choose a project" };
  if (state.dispatchPaused)
    return {
      eligible: false,
      wait: "dispatch_paused",
      message: "Dispatch is paused; resume it to start new work",
    };
  if (!project.automationEnabled)
    return {
      eligible: false,
      wait: "project_automation_disabled",
      message: `Auto-start is off for ${project.name}`,
    };
  const unmet = input.dependencies
    .map((id) => state.tasks[id])
    .filter((t): t is Task => !!t && t.state !== "done");
  if (unmet.length > 0)
    return {
      eligible: false,
      wait: "dependency",
      message: `Waiting on ${unmet.map((t) => t.title).join(", ")}`,
    };
  if (input.notBefore && Date.parse(input.notBefore) > Date.now())
    return {
      eligible: false,
      wait: "scheduled_time",
      message: `Scheduled for ${new Date(input.notBefore).toLocaleString()}`,
    };
  const hostId = input.hostId ?? project.defaultHostId;
  const host = hostId ? state.hosts[hostId] : undefined;
  if (!host || host.revokedAt)
    return {
      eligible: false,
      wait: "invalid_configuration",
      message: "No host is configured for this project",
    };
  if (!host.piCompatible)
    return {
      eligible: false,
      wait: "invalid_configuration",
      message: `Pi on ${host.name} is not compatible`,
    };
  if (host.connectivity !== "connected")
    return { eligible: false, wait: "host_offline", message: `${host.name} is offline` };
  if ((state.runningByProject[project.id] ?? 0) >= project.maxConcurrentRuns)
    return {
      eligible: false,
      wait: "project_limit",
      message: `${project.name} already runs ${project.maxConcurrentRuns} of ${project.maxConcurrentRuns} allowed tasks`,
    };
  return { eligible: true, hostId: host.id, hostName: host.name };
}

/* ------------------------------------------------------------------ */
/* Card text                                                           */
/* ------------------------------------------------------------------ */

export function openAttentionByTask(
  attention: Record<string, AttentionItem>,
): Map<string, AttentionItem[]> {
  const m = new Map<string, AttentionItem[]>();
  for (const a of Object.values(attention)) {
    if (a.resolvedAt || !a.taskId) continue;
    const list = m.get(a.taskId) ?? [];
    list.push(a);
    m.set(a.taskId, list);
  }
  return m;
}

export function dependencySummary(task: Task, tasks: Record<string, Task>): string | null {
  const n = task.dependencies.length;
  if (n === 0) return null;
  const open = task.dependencies.filter((id) => tasks[id]?.state !== "done").length;
  const base = `${n} ${n === 1 ? "dependency" : "dependencies"}`;
  return open > 0 ? `${base} (${open} open)` : `${base} (all done)`;
}
