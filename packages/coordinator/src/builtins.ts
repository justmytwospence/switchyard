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
import { CheckoutProvisionService } from "./checkout-provision.js";
import type { CoordinatorContext } from "./context.js";
import { GitHubService } from "./github.js";
import { parse } from "./http.js";
import { IssueWorkService } from "./issue-work.js";
import type { PolicyOwner } from "./policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "./policies/service.js";
import { ProjectCatalog, type RepositoryProvider } from "./project-catalog.js";
import { type PushSender, PushService } from "./push.js";
import { RepositoryIssuesService } from "./repository-issues.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerPolicyRoutes } from "./routes/policies.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { ScopeSourceService } from "./scope-sources.js";
import type { BuiltinServices } from "./services.js";
import { requireConnected } from "./sessions/service.js";
import {
  DEFAULT_DISPATCHER_OPTIONS,
  Dispatcher,
  type DispatcherOptions,
} from "./tasks/dispatcher.js";
import { RunsService } from "./tasks/runs.js";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.js";

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
  /** @deprecated Old test callers may still pass this; project folders are not scanned. */
  projectScanIntervalMs?: number;
  repositoryProvider?: RepositoryProvider;
  /** Prompt-cache alert tick (default 15 s; 0 disables the timer). */
  cacheAlertTickMs?: number;
  /** Worktree session and landed-removal tick (default 5 min; 0 disables the timer). */
  workspaceLifecycleTickMs?: number;
  /** Scope source sync tick (default 2 min; 0 disables the timer). */
  scopeSyncTickMs?: number;
  /** Policy rule evaluator (default: a new two-worker pool owned by this coordinator). Tests share one. */
  policyEvaluator?: PolicyServiceOptions["evaluator"];
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
    evaluator: opts.policyEvaluator,
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
  const catalog = new ProjectCatalog(ctx, opts.repositoryProvider);
  const cacheAlerts = new CacheAlertService(ctx, { tickMs: opts.cacheAlertTickMs ?? 15_000 });
  const github = new GitHubService(ctx);
  const workspaceLifecycle = new WorkspaceLifecycleService(ctx, {
    tickMs: opts.workspaceLifecycleTickMs ?? 300_000,
  });
  const scopeSources = new ScopeSourceService(ctx, {
    tickMs: opts.scopeSyncTickMs ?? 120_000,
  });
  const services: BuiltinServices = {
    github,
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
    catalog,
    checkoutProvision: new CheckoutProvisionService(ctx),
    workspaceLifecycle,
    scopeSources,
    issueWork: new IssueWorkService(ctx),
    repositoryIssues: new RepositoryIssuesService(ctx),
  };
  for (const [name, svc] of Object.entries(services)) ctx.services.set(name, svc);
  ctx.hostHub.setImportedCheckoutHandler((session) => {
    void services.checkoutProvision.adoptImported(session);
  });
  registerPolicyRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerIssueRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerPushRoutes(app, ctx);
  return {
    services,
    async start() {
      await policies.initialize();
      services.issueWork.recoverInterrupted();
      ctx.hostHub.setAvailableAgentFeatures(new Set(["agentRequests.v1", "policies.v1"]));
      push.vapid();
      runs.start();
      automations.start();
      notifications.start();
      dispatcher.start();
      scheduler.start();
      catalog.start();
      cacheAlerts.start();
      messages.start();
      github.start();
      workspaceLifecycle.start();
      scopeSources.start();
    },
    async stop() {
      ctx.hostHub.setAgentHandler(null);
      lifetime.abort(new SwitchyardError("host_unreachable", "The coordinator is stopping."));
      const messagesStopped = messages.stop();
      scopeSources.stop();
      workspaceLifecycle.stop();
      github.stop();
      cacheAlerts.stop();
      catalog.stop();
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
