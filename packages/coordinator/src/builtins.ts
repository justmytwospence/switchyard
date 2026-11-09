import {
  type AgentRequestFrame,
  HostPolicySampleResult,
  PolicyCancelRequest,
  PolicyStatusRequest,
  SwitchyardError,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { createMessageDeliveryTransport, MessageService } from "./agents/messages.js";
import { AgentService } from "./agents/service.js";
import { NotificationRouter } from "./attention/router.js";
import { Scheduler } from "./automations/scheduler.js";
import { AutomationService } from "./automations/service.js";
import { CacheAlertService } from "./cache-alerts.js";
import type { CoordinatorContext } from "./context.js";
import { parse } from "./http.js";
import type { PolicyOwner } from "./policies/contracts.js";
import { PolicyService } from "./policies/service.js";
import { PROJECT_SCAN_INTERVAL_MS, ProjectFolderService } from "./project-folders.js";
import { type PushSender, PushService } from "./push.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerPolicyRoutes } from "./routes/policies.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { BuiltinServices } from "./services.js";
import { requireConnected } from "./sessions/service.js";
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
): { services: BuiltinServices; start(): Promise<void>; stop(): Promise<void> } {
  const dispatcher = new Dispatcher(ctx, { ...DEFAULT_DISPATCHER_OPTIONS, ...opts.dispatcher });
  const messages = new MessageService(ctx.store, createMessageDeliveryTransport(ctx.hostHub));
  const lifetime = new AbortController();
  const policies = new PolicyService({
    store: ctx.store,
    get publicUrl() {
      return ctx.config.publicUrl;
    },
    reconcileInputAttention: (interaction) => ctx.hostHub.reconcileInputAttention(interaction),
    hostPolicyConnection: (hostId) => ({
      connected: ctx.hostHub.isConnected(hostId),
      features: ctx.hostHub.negotiatedFeatures(hostId),
    }),
    classifySample: async (request, { signal }) => {
      signal?.throwIfAborted();
      const session = ctx.store.sessions.require(request.sessionId);
      if (!ctx.hostHub.negotiatedFeatures(session.hostId).has("policies.v1")) {
        throw new SwitchyardError("unsupported_capability", "Host policies were not negotiated");
      }
      if (
        session.bridge?.policyState !== "active" ||
        !session.bridge.policyPhases.includes("tool_call") ||
        session.bridge.runtimeId !== request.runtimeId ||
        session.bridge.nativeSessionId !== request.nativeSessionId ||
        (session.nativeHandle !== null &&
          session.nativeHandle.sessionId !== request.nativeSessionId)
      ) {
        throw new SwitchyardError("stale_control", "The policy test runtime binding changed.");
      }
      const result = await ctx.hostHub.request(
        session.hostId,
        { type: "session.classifyPolicySample", ...request },
        { timeoutMs: 10_000 },
      );
      signal?.throwIfAborted();
      return parse(HostPolicySampleResult, result);
    },
  });
  const ownerOf = (hostId: string, frame: AgentRequestFrame): PolicyOwner => ({
    authenticatedHostId: hostId,
    sessionId: frame.sessionId,
    nativeSessionId: frame.nativeSessionId,
    runtimeId: frame.runtimeId,
  });
  const agents = new AgentService({
    store: ctx.store,
    messages,
    scheduleDispatch: () => dispatcher.schedule(),
    negotiatedFeatures: (hostId) => ctx.hostHub.negotiatedFeatures(hostId),
    publicUrl: () => ctx.config.publicUrl,
    launchRequirement: (caller) =>
      policies.launchRequirement({
        sessionId: caller.id,
        profileId: caller.profileSnapshot.id,
        continuation: ctx.store.runForSession(caller)?.limits ?? { enabled: false },
      }),
    bindPolicyBoundary: (owner, boundary) => policies.bindBoundary(owner, boundary),
    onUnbind: (sessionId, runtimeId) => policies.cancelForSession(sessionId, runtimeId),
    // ASK is a nonfinal tool reply. Only an explicit same-toolCallId retry may mutate;
    // policy.status/approval must never awaken a suspended request closure.
    authorize: ({ caller }, frame) =>
      policies.authorize({
        kind: "agent_request",
        owner: ownerOf(caller.hostId, frame),
        frame,
        signal: lifetime.signal,
      }),
    assertAuthorization: ({ caller }, frame) => {
      lifetime.signal.throwIfAborted();
      requireConnected(ctx, caller.hostId);
      policies.assertAuthorized({
        kind: "agent_request",
        owner: ownerOf(caller.hostId, frame),
        frame,
      });
    },
    policyRequest: async ({ caller }, frame, hostContext) => {
      const owner = ownerOf(caller.hostId, frame);
      switch (frame.method) {
        case "policy.evaluate":
          if (!hostContext) {
            throw new SwitchyardError("forbidden", "Host policy context is required");
          }
          return policies.authorize({
            kind: "tool",
            owner,
            frame,
            hostContext,
            signal: lifetime.signal,
          });
        case "policy.status":
          return policies.status(owner, parse(PolicyStatusRequest, frame.args), lifetime.signal);
        case "policy.cancel":
          return policies.cancel(owner, parse(PolicyCancelRequest, frame.args));
        default:
          throw new SwitchyardError("invalid_request", "Invalid policy request method");
      }
    },
  });
  ctx.hostHub.setAgentHandler((hostId, frame, hostContext) =>
    agents.handle(hostId, frame, hostContext),
  );
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
    policies,
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
  registerPolicyRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerPushRoutes(app, ctx);
  return {
    services,
    async start() {
      await policies.initialize();
      ctx.hostHub.setAvailableAgentFeatures(new Set(["agentRequests.v1", "policies.v1"]));
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
      ctx.hostHub.setAgentHandler(null);
      lifetime.abort(new SwitchyardError("host_unreachable", "The coordinator is stopping."));
      const messagesStopped = messages.stop();
      cacheAlerts.stop();
      projectFolders.stop();
      scheduler.stop();
      dispatcher.stop();
      notifications.stop();
      automations.stop();
      runs.stop();
      await messagesStopped;
      await policies.stop();
    },
  };
}
