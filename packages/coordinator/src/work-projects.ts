import { isListedProject, type Project, SwitchyardError } from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { requireListedRepository } from "./project-catalog.js";

export type WorkProjectContext = CoordinatorContext | Pick<CoordinatorContext, "store">;

/** Metadata is absent only on programmatically seeded fixtures; migration labels history explicitly. */
export function hasWorkMembership(project: Project): boolean {
  return project.catalog === undefined || isListedProject(project);
}

/** Fresh catalog gate for side effects, including a provider's confirmed suspension. */
export function requireWorkProject(ctx: WorkProjectContext, id: string): Project {
  const project = ctx.store.projects.require(id);
  if (project.catalog === undefined) return project;
  return requireListedRepository(ctx.store, project);
}

export function canWorkOnProject(ctx: CoordinatorContext, id: string): boolean {
  try {
    requireWorkProject(ctx, id);
    return true;
  } catch (err) {
    if (err instanceof SwitchyardError && (err.code === "conflict" || err.code === "not_found")) {
      return false;
    }
    throw err;
  }
}
