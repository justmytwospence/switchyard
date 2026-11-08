import {
  CreateTaskRequest,
  DEFAULT_TASK_POLICY,
  mergePatch,
  newId,
  SwitchyardError,
  type Task,
  TaskPolicy,
  type TaskPolicyPatch,
} from "@switchyard/protocol";
import type { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { detectCycle } from "./state.js";

type TaskContext = Pick<CoordinatorContext, "store">;
export type CreateTaskInput = z.input<typeof CreateTaskRequest> & { groupingKey?: string | null };

/** Root tasks have depth zero; no task may have more than 16 ancestors. */
export const MAX_PARENT_DEPTH = 16;

export function mergePolicy(base: TaskPolicy, patch: TaskPolicyPatch | undefined): TaskPolicy {
  return parse(TaskPolicy, mergePatch(base, patch), "policy");
}

export function nextPosition(ctx: TaskContext, projectId: string): number {
  const max = ctx.store.tasks
    .list("project_id = ?", [projectId])
    .reduce((m, t) => Math.max(m, t.position), 0);
  return max + 1024;
}

/** Existing cross-project edges may be retained, but no new ones may be added. */
export function validateDependencies(
  ctx: TaskContext,
  taskId: string,
  projectId: string,
  title: string,
  dependencies: string[],
  previous: readonly string[] = [],
): void {
  for (const id of dependencies) {
    if (id === taskId) {
      throw new SwitchyardError("dependency_cycle", "A task cannot depend on itself");
    }
    const dependency = ctx.store.tasks.require(id);
    if (dependency.projectId !== projectId && !previous.includes(id)) {
      throw new SwitchyardError(
        "invalid_request",
        "Dependencies must belong to the task's project",
      );
    }
  }
  detectCycle(taskId, dependencies, (id) => ctx.store.tasks.get(id), title);
}

/** Validate the proposed ancestry, including the depth of descendants when reparenting. */
export function validateParent(
  ctx: TaskContext,
  taskId: string,
  projectId: string,
  parentTaskId: string | null,
): void {
  const seen = new Set([taskId]);
  let depth = 0;
  let id = parentTaskId;
  while (id !== null) {
    if (seen.has(id)) {
      throw new SwitchyardError(
        "invalid_request",
        "A task's parent cannot introduce an ancestry cycle",
      );
    }
    seen.add(id);
    const parent = ctx.store.tasks.require(id);
    if (parent.projectId !== projectId) {
      throw new SwitchyardError("invalid_request", "Parent tasks must belong to the same project");
    }
    if (++depth > MAX_PARENT_DEPTH) {
      throw new SwitchyardError(
        "invalid_request",
        `Task hierarchy depth cannot exceed ${MAX_PARENT_DEPTH}`,
      );
    }
    id = parent.parentTaskId ?? null;
  }

  // Moving a subtree must not push an existing descendant past the same depth limit.
  const visit = (childId: string, childDepth: number): void => {
    for (const child of ctx.store.tasks.list("parent_task_id = ?", [childId])) {
      if (seen.has(child.id)) {
        throw new SwitchyardError(
          "invalid_request",
          "A task's parent cannot introduce an ancestry cycle",
        );
      }
      if (childDepth + 1 > MAX_PARENT_DEPTH) {
        throw new SwitchyardError(
          "invalid_request",
          `Task hierarchy depth cannot exceed ${MAX_PARENT_DEPTH}`,
        );
      }
      seen.add(child.id);
      visit(child.id, childDepth + 1);
      seen.delete(child.id);
    }
  };
  visit(taskId, depth);
}

/** Shared synchronous constructor; joins the caller's transaction and never launches work. */
export function createTask(
  ctx: TaskContext,
  input: CreateTaskInput,
  origin: Task["origin"],
  agentOrigin?: Task["agentOrigin"],
): Task {
  const body = parse(CreateTaskRequest, input);
  if (body.githubIssueUrl !== undefined) {
    throw new SwitchyardError(
      "unsupported_capability",
      "GitHub issue task import is not enabled yet.",
    );
  }
  const { store } = ctx;
  return store.tx(() => {
    store.projects.require(body.projectId);
    const id = newId("tsk");
    validateDependencies(ctx, id, body.projectId, body.title, body.dependencies);
    const parentTaskId = body.parentTaskId ?? null;
    validateParent(ctx, id, body.projectId, parentTaskId);
    const policy = mergePolicy(DEFAULT_TASK_POLICY, body.policy);
    if (agentOrigin) {
      if (policy.hostId) {
        const host = store.hosts.require(policy.hostId);
        if (host.revokedAt)
          throw new SwitchyardError("invalid_request", "The hinted host has been revoked");
        if (!store.checkouts.count("project_id = ? AND host_id = ?", [body.projectId, host.id])) {
          throw new SwitchyardError(
            "invalid_request",
            "The hinted host has no checkout for this project",
          );
        }
      }
      if (policy.profileId) store.profiles.require(policy.profileId);
    }
    const now = store.nowIso();
    return store.putTask({
      id,
      projectId: body.projectId,
      title: body.title,
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria,
      dependencies: body.dependencies,
      parentTaskId,
      priority: body.priority,
      position: nextPosition(ctx, body.projectId),
      state: body.state,
      blocked: null,
      notBefore: body.notBefore ?? null,
      policy,
      origin,
      ...(agentOrigin ? { agentOrigin } : {}),
      groupingKey: input.groupingKey ?? null,
      currentRunId: null,
      sessionId: null,
      review: { feedback: [], changesRequested: false },
      hiddenFromBoard: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}
