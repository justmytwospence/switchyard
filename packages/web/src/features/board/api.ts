import type { Eligibility, Run, Task, TaskPolicyPatch, TaskState } from "@switchyard/protocol";
import { apiDelete, apiGet, apiPatch, apiPost, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

/** REST helpers for tasks. Results are written to the store once acknowledged (no optimistic success). */

const base = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

function asTask(res: unknown): Task | null {
  if (!res || typeof res !== "object") return null;
  const r = res as { task?: Task; id?: string; state?: string };
  if (r.task && typeof r.task === "object") return r.task;
  if (typeof r.id === "string" && typeof r.state === "string") return r as Task;
  return null;
}

/** Store the acknowledged task unless a newer version already arrived over the socket. */
export function upsertTask(res: unknown): Task | null {
  const task = asTask(res);
  if (!task) return null;
  useSyncStore.setState((s) => {
    const prev = s.tasks[task.id];
    if (prev && prev.updatedAt > task.updatedAt) return {};
    return { tasks: { ...s.tasks, [task.id]: task } };
  });
  return task;
}

export interface CreateTaskBody {
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  parentTaskId?: string | null;
  priority: 0 | 1 | 2 | 3;
  state: "backlog" | "ready";
  notBefore?: string | null;
  policy?: TaskPolicyPatch;
}

export async function createTask(body: CreateTaskBody): Promise<Task> {
  const res = await apiPost<unknown>("/api/tasks", body);
  const t = upsertTask(res);
  if (!t) throw new Error("The coordinator returned an unexpected response");
  return t;
}

export type UpdateTaskBody = Partial<Omit<CreateTaskBody, "projectId" | "state">> & {
  position?: number;
};

export async function updateTask(id: string, patch: UpdateTaskBody): Promise<Task | null> {
  return upsertTask(await apiPatch<unknown>(base(id), patch));
}

export async function deleteTask(id: string): Promise<void> {
  await apiDelete(base(id));
  useSyncStore.setState((s) => {
    if (!s.tasks[id]) return {};
    const { [id]: _gone, ...rest } = s.tasks;
    return { tasks: rest };
  });
}

export interface MoveBody {
  to: TaskState;
  confirm?: boolean;
  onRunning?: "pause" | "stop";
  position?: number;
}

export async function moveTask(id: string, body: MoveBody): Promise<Task | null> {
  return upsertTask(await apiPost<unknown>(`${base(id)}/move`, body));
}

export type TaskAction = "run-now" | "accept" | "new-attempt" | "reopen" | "cancel";

export async function taskAction(
  id: string,
  action: TaskAction,
  body?: unknown,
  query?: string,
): Promise<Task | null> {
  return upsertTask(await apiPost<unknown>(`${base(id)}/${action}${query ?? ""}`, body));
}

export async function requestChanges(id: string, feedback: string[]): Promise<Task | null> {
  return upsertTask(await apiPost<unknown>(`${base(id)}/request-changes`, { feedback }));
}

export function fetchEligibility(id: string, signal?: AbortSignal): Promise<Eligibility> {
  return apiGet<Eligibility>(`${base(id)}/eligibility`, undefined, signal);
}

export async function fetchRuns(id: string, signal?: AbortSignal): Promise<Run[]> {
  const res = await apiGet<Run[] | { runs: Run[] }>(`${base(id)}/runs`, undefined, signal);
  return Array.isArray(res) ? res : (res.runs ?? []);
}

export async function setDispatchPaused(paused: boolean): Promise<void> {
  await apiPost("/api/dispatch/pause", { paused });
  useSyncStore.setState({ dispatchPaused: paused });
}

/** A 409 that asks the user to confirm (e.g. Done with unresolved checks). */
export function needsConfirmation(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.status !== 409 && e.code !== "invalid_transition") return false;
  const d = e.details as { needsConfirm?: boolean; needsChoice?: boolean } | undefined;
  return d?.needsConfirm === true || /confirm/i.test(e.message);
}

/** A 409 that asks for the running-work choice (pause automation or stop execution). */
export function needsRunningChoice(e: unknown): boolean {
  if (!isApiError(e)) return false;
  const d = e.details as
    | { needsChoice?: boolean; onRunning?: boolean; choices?: unknown }
    | undefined;
  return (
    Array.isArray(d?.choices) ||
    d?.needsChoice === true ||
    d?.onRunning === true ||
    /pause automation or stop execution/i.test(e.message)
  );
}
