import type { FastifyInstance } from "fastify";
import { createMessageDeliveryTransport, MessageService } from "./agents/messages.js";
import { AgentService } from "./agents/service.js";
import { NotificationRouter } from "./attention/router.js";
import { Scheduler } from "./automations/scheduler.js";
import { AutomationService } from "./automations/service.js";
import { CacheAlertService } from "./cache-alerts.js";
import type { CoordinatorContext } from "./context.js";
import { PROJECT_SCAN_INTERVAL_MS, ProjectFolderService } from "./project-folders.js";
import { type PushSender, PushService } from "./push.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { BuiltinServices } from "./services.js";
import {
  DEFAULT_DISPATCHER_OPTIONS,
  Dispatcher,
  type DispatcherOptions,
} from "./tasks/dispatcher.js";
import { RunsService } from "./tasks/runs.js";

export interface BuiltinOptions {
  /** Push delivery (default: web-push with the stored VAPID keys). */
  pushSender?: PushSender;
  dispatcher?: Partial<DispatcherOptions>;
  /** Scheduler tick (default 15 s; 0 disables the timer). */
  schedulerTickMs?: number;
  /** `checks.run` timeout (default 2 h). */
  checksTimeoutMs?: number;
  /** Desktop "recently active" window for notification routing (default 5 min). */
  desktopRecentMs?: number;
  /** Project folder rescan interval (default 10 min; 0 disables the timer). */
  projectScanIntervalMs?: number;
  /** Prompt-cache alert tick (default 15 s; 0 disables the timer). */
  cacheAlertTickMs?: number;
}

/**
 * Tasks, dispatch, runs, automations, push and notification routing. Services and routes are
 * created with the coordinator; `start()` subscribes them and starts their timers.
 */
export function installBuiltins(
  app: FastifyInstance,
  ctx: CoordinatorContext,
  opts: BuiltinOptions = {},
): { services: BuiltinServices; start(): void; stop(): Promise<void> } {
  const dispatcher = new Dispatcher(ctx, { ...DEFAULT_DISPATCHER_OPTIONS, ...opts.dispatcher });
  const messages = new MessageService(ctx.store, createMessageDeliveryTransport(ctx.hostHub));
  const agents = new AgentService({
    store: ctx.store,
    messages,
    scheduleDispatch: () => dispatcher.schedule(),
    negotiatedFeatures: (hostId) => ctx.hostHub.negotiatedFeatures(hostId),
  });
  ctx.hostHub.setAgentHandler((hostId, frame) => agents.handle(hostId, frame));
  const runs = new RunsService(ctx, { checksTimeoutMs: opts.checksTimeoutMs ?? 2 * 3_600_000 });
  const automations = new AutomationService(ctx);
  const scheduler = new Scheduler(ctx, automations, { tickMs: opts.schedulerTickMs ?? 15_000 });
  const push = new PushService(ctx, opts.pushSender);
  const notifications = new NotificationRouter(ctx, push, {
    desktopRecentMs: opts.desktopRecentMs ?? 5 * 60_000,
  });
  const projectFolders = new ProjectFolderService(ctx, {
    intervalMs: opts.projectScanIntervalMs ?? PROJECT_SCAN_INTERVAL_MS,
  });
  const cacheAlerts = new CacheAlertService(ctx, { tickMs: opts.cacheAlertTickMs ?? 15_000 });
  const services: BuiltinServices = {
    agents,
    messages,
    cacheAlerts,
    dispatcher,
    runs,
    automations,
    scheduler,
    push,
    notifications,
    projectFolders,
  };
  for (const [name, svc] of Object.entries(services)) ctx.services.set(name, svc);
  registerTaskRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerPushRoutes(app, ctx);
  return {
    services,
    start() {
      push.vapid();
      runs.start();
      automations.start();
      notifications.start();
      dispatcher.start();
      scheduler.start();
      projectFolders.start();
      cacheAlerts.start();
      messages.start();
    },
    async stop() {
      const messagesStopped = messages.stop();
      cacheAlerts.stop();
      projectFolders.stop();
      scheduler.stop();
      dispatcher.stop();
      notifications.stop();
      automations.stop();
      runs.stop();
      await messagesStopped;
    },
  };
}
