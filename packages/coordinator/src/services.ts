import type { MessageService } from "./agents/messages.js";
import type { AgentService } from "./agents/service.js";
import type { NotificationRouter } from "./attention/router.js";
import type { Scheduler } from "./automations/scheduler.js";
import type { AutomationService } from "./automations/service.js";
import type { CacheAlertService } from "./cache-alerts.js";
import type { CoordinatorContext } from "./context.js";
import type { GitHubService } from "./github.js";
import type { PolicyService } from "./policies/service.js";
import type { ProjectFolderService } from "./project-folders.js";
import type { PushService } from "./push.js";
import type { Dispatcher } from "./tasks/dispatcher.js";
import type { RunsService } from "./tasks/runs.js";

/** Built-in services registered in `ctx.services` by `createCoordinator`. */
export interface BuiltinServices {
  github: GitHubService;
  policies: PolicyService;
  agents: AgentService;
  messages: MessageService;
  dispatcher: Dispatcher;
  runs: RunsService;
  automations: AutomationService;
  scheduler: Scheduler;
  push: PushService;
  notifications: NotificationRouter;
  projectFolders: ProjectFolderService;
  cacheAlerts: CacheAlertService;
}

/** Typed lookup of a built-in service (undefined before `start()` registers it). */
export function getService<K extends keyof BuiltinServices>(
  ctx: CoordinatorContext,
  name: K,
): BuiltinServices[K] | undefined {
  return ctx.services.get(name) as BuiltinServices[K] | undefined;
}

/** Like `getService` but throws when missing. */
export function requireService<K extends keyof BuiltinServices>(
  ctx: CoordinatorContext,
  name: K,
): BuiltinServices[K] {
  const s = getService(ctx, name);
  if (!s) throw new Error(`Service ${name} is not registered`);
  return s;
}
