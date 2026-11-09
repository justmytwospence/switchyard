import { randomUUID } from "node:crypto";
import {
  AGENT_FRAME_MAX_BYTES,
  AgentRequestFrame,
  type AgentResultFrame,
  AgentToolPolicyWait,
  HostPolicyBoundary,
  type HostToolPolicyContext,
  PolicyEvaluateRequest,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { z } from "zod";
import type { CoordinatorLink } from "./link.js";

const Id = z.string().min(1).max(200);
const Context = AgentRequestFrame.shape.context;
const Capabilities = z.object({
  agentTools: z.boolean(),
  messageDelivery: z.boolean(),
  editorDraftGuard: z.boolean(),
  toolPolicy: z.boolean(),
});
const Hello = z.object({
  type: z.literal("agent.hello"),
  version: z.literal(1),
  runtimeId: Id,
  nativeSessionId: Id,
  sessionFile: z.string().nullable(),
  pid: z.number().int().positive(),
  mode: z.enum(["rpc", "terminal"]),
  capabilities: Capabilities,
  context: Context,
});
const BindResult = z
  .object({
    version: z.literal(1),
    sessionId: Id,
    runtimeId: Id,
    nativeSessionId: Id,
    features: z.array(Id),
    policyRequired: z.boolean(),
    sessionUrl: z.string().url().nullable(),
  })
  .strict();
const Configured = z
  .object({
    configured: z.literal(true),
    agentTools: z.boolean(),
    messageDelivery: z.boolean(),
    policyRequired: z.boolean(),
    policyState: z.enum(["initializing", "active", "unsupported", "lost"]),
    policyPhases: z.array(z.enum(["tool_call", "request"])),
  })
  .strict();
const LocalRequest = AgentRequestFrame.extend({
  bindingId: Id,
  context: Context.strict(),
}).strict();
const ReplyIdentity = z.object({
  type: z.literal("agent.request"),
  requestId: Id,
  runtimeId: Id,
  bindingId: Id,
});

export type AgentBrokerHello = z.infer<typeof Hello>;
export type AgentBrokerConfiguration = z.infer<typeof BindResult> & {
  bindingId: string;
  coordinatorConnected: boolean;
};
export type AgentBrokerRequest = AgentRequestFrame & { bindingId: string };
export type AgentBrokerResult = AgentResultFrame & { bindingId: string };
export type AgentBrokerState = NonNullable<Session["bridge"]> & {
  nativeSessionId: string;
  controllerEpoch: string;
};
export interface AgentBrokerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The supervisor supplies one adapter per actual ManagedSession, not per request. Register
 * bridge_features -> handle.hello, agent_request -> handle.request, bridge_lost -> handle.lost,
 * and exit -> handle.close directly, OUTSIDE Live.chain and both CommandRouter queues.
 *
 * hello takes the actual A.1 agent.hello (including capabilities), not Session.bridge's
 * projected state. bridgeRequest is the transport's independent, identity-fenced receipt lane;
 * configureAgent must pass this configuration unchanged and return its actual receipt result.
 * replyAgent must retain the originating transport, which fences obsolete binding IDs.
 */
export interface AgentBrokerSession {
  readonly sessionId: string;
  readonly mode: "rpc" | "terminal";
  /** Authoritative launch record, never a tool argument. A true value is latched until close. */
  readonly policyRequired: boolean;
  /** Resolve/verify the original host launch cwd and workspace root, never hello/tool fields. */
  getPolicyBoundary(): Promise<HostPolicyBoundary>;
  /** Reverify the pinned boundary and classify this exact tool outside the session chain. */
  getToolPolicyContext(
    request: PolicyEvaluateRequest,
    signal?: AbortSignal,
  ): Promise<HostToolPolicyContext>;
  configureAgent(
    configuration: AgentBrokerConfiguration,
    options?: AgentBrokerRequestOptions,
  ): Promise<unknown>;
  bridgeRequest(
    method: "connection.update" | "input.human",
    args: { connected: boolean } | { humanInputId: string },
    options?: AgentBrokerRequestOptions,
  ): Promise<unknown>;
  replyAgent(frame: AgentBrokerResult): void;
  setPolicyWaiting(decisionId: string, waiting: boolean): void;
  /** Persist/expose actual state. This callback must not enqueue work ahead of a prompt. */
  onState?(state: AgentBrokerState): void;
}

export interface AgentBrokerOptions {
  /** Structural on purpose: the production CoordinatorLink satisfies this without a wrapper. */
  link: Pick<CoordinatorLink, "connected" | "negotiatedFeatures" | "requestAgent" | "events">;
  /** Startup/reconnection limit, capped at 30 seconds. */
  timeoutMs?: number;
  onError?(error: unknown, sessionId: string): void;
}

const MAX_WAIT_MS = 30_000;
function deadlineMs(value = MAX_WAIT_MS): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new SwitchyardError("invalid_request", "A finite positive broker timeout is required");
  return Math.min(value, MAX_WAIT_MS);
}
function stale(): SwitchyardError {
  return new SwitchyardError("stale_control", "Bridge identity or local binding is obsolete");
}
function body(error: unknown) {
  return error instanceof SwitchyardError
    ? error.toBody()
    : new SwitchyardError("internal", "Agent broker request failed").toBody();
}

/** Owns only the authenticated agent lane; no prompts, native RPC, outbox or session lifecycle. */
export class AgentBroker {
  private readonly sessions = new Map<string, AgentBrokerHandle>();
  private closed = false;
  readonly timeoutMs: number;
  readonly link: AgentBrokerOptions["link"];

  constructor(private readonly options: AgentBrokerOptions) {
    this.link = options.link;
    this.timeoutMs = deadlineMs(options.timeoutMs);
    this.link.events.on("welcome", this.welcome);
    this.link.events.on("disconnected", this.disconnected);
    this.link.events.on("rejected", this.disconnected);
  }

  attach(session: AgentBrokerSession): AgentBrokerHandle {
    if (this.closed) throw new SwitchyardError("host_unreachable", "Agent broker is closed");
    // Explicitly fencing a controller replacement also prevents an old handle from replying
    // through a newly attached ManagedSession with the same Switchyard session id.
    this.sessions.get(session.sessionId)?.close();
    const handle = new AgentBrokerHandle(this, session);
    this.sessions.set(session.sessionId, handle);
    return handle;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.link.events.off("welcome", this.welcome);
    this.link.events.off("disconnected", this.disconnected);
    this.link.events.off("rejected", this.disconnected);
    for (const handle of this.sessions.values()) handle.close();
    this.sessions.clear();
  }

  /** Internal hooks also make closing an individual session release its broker resources. */
  forget(handle: AgentBrokerHandle): void {
    if (this.sessions.get(handle.sessionId) === handle) this.sessions.delete(handle.sessionId);
  }
  report(error: unknown, sessionId: string): void {
    this.options.onError?.(error, sessionId);
  }

  private readonly welcome = () => {
    for (const handle of this.sessions.values()) handle.reconnect();
  };
  private readonly disconnected = () => {
    for (const handle of this.sessions.values()) handle.disconnect();
  };
}

/** A capability tied to one owning session. Requests can never select another adapter. */
export class AgentBrokerHandle {
  readonly sessionId: string;
  private helloRecord: AgentBrokerHello | null = null;
  private configuration: AgentBrokerConfiguration | null = null;
  // Public durable identity of the local controller, never sent to or supplied by Pi.
  private controllerEpoch: string | null = null;
  private configurationAttempted = false;
  private state: AgentBrokerState | null = null;
  private required: boolean;
  private closed = false;
  private generation = 0;
  private syncing: Promise<void> | null = null;
  private failure: unknown = null;
  private syncController: AbortController | null = null;
  private readonly pending = new Map<AbortController, string | null>();
  private readonly decisions = new Map<string, NodeJS.Timeout>();
  private readonly changes = new Set<() => void>();

  constructor(
    private readonly broker: AgentBroker,
    private readonly session: AgentBrokerSession,
  ) {
    this.sessionId = session.sessionId;
    this.required = session.policyRequired;
  }

  snapshot(): { configuration: AgentBrokerConfiguration | null; bridge: AgentBrokerState | null } {
    return structuredClone({ configuration: this.configuration, bridge: this.state });
  }

  /** Call on every actual hello, including reattachment. Even the same runtime gets a new fence. */
  async hello(record: unknown): Promise<void> {
    const parsed = Hello.safeParse(record);
    if (!parsed.success || parsed.data.mode !== this.session.mode)
      throw new SwitchyardError("invalid_request", "Invalid or substituted bridge hello");
    if (this.closed) throw stale();
    this.invalidate();
    this.helloRecord = parsed.data;
    this.required ||= this.session.policyRequired;
    this.configuration = null;
    this.controllerEpoch = randomUUID();
    this.configurationAttempted = false;
    this.failure = null;
    this.publish("initializing");
    await this.synchronize();
  }

  /** Required launches await this BEFORE sending their initial prompt (30 seconds maximum). */
  async ready(
    options: AgentBrokerRequestOptions & { require?: "agentRequests" | "policies" } = {},
  ): Promise<AgentBrokerConfiguration> {
    const require = options.require ?? (this.required ? "policies" : "agentRequests");
    const deadline = Date.now() + deadlineMs(options.timeoutMs ?? this.broker.timeoutMs);
    for (;;) {
      if (this.closed) throw stale();
      if (options.signal?.aborted) throw options.signal.reason ?? stale();
      const configuration = this.configuration;
      if (this.failure && !this.syncing) throw this.failure;
      if (configuration && this.broker.link.connected && configuration.coordinatorConnected) {
        const supported =
          configuration.features.includes("agentRequests.v1") &&
          (require === "agentRequests" || this.state?.policyState === "active");
        if (!supported)
          throw new SwitchyardError(
            "unsupported_capability",
            "The live bridge is not protected/supported",
          );
        return structuredClone(configuration);
      }
      await this.changed(deadline, options.signal);
    }
  }

  /**
   * frame.context is extension-owned branch state, validated on the local socket. It is NOT
   * read from frame.args (which is model input). The local binding is stripped by constructing
   * a fresh link request; its captured value is restored only on the originating local result.
   * The extension owns bounded retries, preserving toolCallId; the broker never replays effects.
   */
  async request(record: unknown): Promise<void> {
    const parsed = LocalRequest.safeParse(record);
    if (!parsed.success) {
      const identity = ReplyIdentity.safeParse(record);
      if (identity.success && !this.closed)
        this.session.replyAgent({
          ...identity.data,
          type: "agent.result",
          ok: false,
          error: { code: "invalid_request", message: "Invalid local agent request" },
        });
      return;
    }
    const frame = parsed.data;
    const generation = this.generation;
    const controller = new AbortController();
    let decisionId: string | null = null;
    let keepWaiting = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = Math.min(
      Date.now() + MAX_WAIT_MS,
      frame.deadlineAt === undefined ? Infinity : Date.parse(frame.deadlineAt),
    );
    try {
      if (Buffer.byteLength(JSON.stringify(record)) > AGENT_FRAME_MAX_BYTES)
        throw new SwitchyardError("invalid_request", "Agent request exceeds 128 KiB");
      if (frame.sessionId !== this.sessionId)
        throw new SwitchyardError("forbidden", "Agent request does not belong to this session");
      this.assertBinding(frame);
      if (frame.method === "session.bind")
        throw new SwitchyardError("forbidden", "Session binding is broker-only");
      if ((frame.method === "task.create" || frame.method === "message.send") && !frame.toolCallId)
        throw new SwitchyardError("invalid_request", "Tool mutation requires toolCallId");
      const policy = frame.method.startsWith("policy.");
      if (
        !this.configuration?.features.includes("agentRequests.v1") ||
        (policy && !this.configuration.features.includes("policies.v1"))
      )
        throw new SwitchyardError("unsupported_capability", "Agent method is not negotiated");
      if (!this.configuration.coordinatorConnected || !this.broker.link.connected)
        throw new SwitchyardError("host_unreachable", "Coordinator is disconnected");
      if (this.pending.size >= 256)
        throw new SwitchyardError("rate_limited", "Too many pending broker requests");
      if (frame.method === "policy.status" || frame.method === "policy.cancel") {
        const decision = z.object({ decisionId: Id }).safeParse(frame.args);
        if (!decision.success)
          throw new SwitchyardError("invalid_request", "Policy request requires decisionId");
        decisionId = decision.data.decisionId;
      }
      if (!policy && !this.state?.agentTools)
        throw new SwitchyardError(
          "unsupported_capability",
          "The extension has no agent tools installed",
        );
      let evaluation: PolicyEvaluateRequest | undefined;
      if (frame.method === "policy.evaluate") {
        const parsed = PolicyEvaluateRequest.safeParse(frame.args);
        if (!parsed.success || parsed.data.toolCallId !== frame.toolCallId)
          throw new SwitchyardError("invalid_request", "Invalid policy evaluation or toolCallId");
        evaluation = parsed.data;
      }
      // This context was produced by the trusted local channel's native-branch scan.
      if (this.helloRecord) this.helloRecord.context = { ...frame.context };
      if (frame.method === "policy.cancel" && decisionId) this.cancelDecision(decisionId, false);
      this.pending.set(controller, decisionId);
      timer = setTimeout(
        () => controller.abort(new SwitchyardError("timeout", "Agent request timed out")),
        this.remaining(deadline),
      );
      timer.unref();
      let policyContext: HostToolPolicyContext | undefined;
      if (evaluation) {
        this.check(generation, controller.signal);
        policyContext = await this.withSignal(
          this.session.getToolPolicyContext(evaluation, controller.signal),
          controller.signal,
        );
        this.check(generation, controller.signal);
        this.assertBinding(frame);
      }
      const result = await this.withSignal(
        this.broker.link.requestAgent(
          this.sessionId,
          frame.nativeSessionId,
          frame.runtimeId,
          frame.method,
          evaluation ?? frame.args,
          {
            toolCallId: frame.toolCallId,
            context: { ...frame.context },
            ...(policyContext === undefined ? {} : { policyContext }),
            signal: controller.signal,
            timeoutMs: this.remaining(deadline),
            deadlineAt: new Date(deadline).toISOString(),
          },
        ),
        controller.signal,
      );
      if (generation !== this.generation || this.closed || controller.signal.aborted) return;
      this.assertBinding(frame);
      const reply = result as { verdict?: unknown; decisionId?: unknown; state?: unknown } | null;
      if (frame.method === "policy.evaluate" && reply?.verdict === "ASK") {
        if (!Id.safeParse(reply.decisionId).success)
          throw new SwitchyardError(
            "invalid_request",
            "Policy ASK is missing its decision identity",
          );
        this.beginDecision(reply.decisionId as string);
      }
      if (
        frame.method === "task.create" ||
        frame.method === "message.send" ||
        frame.method === "inbox.read"
      ) {
        const wait = AgentToolPolicyWait.safeParse(result);
        if (wait.success) this.beginDecision(wait.data.decisionId);
        else if ((result as { type?: unknown } | null)?.type === "policy.required")
          throw new SwitchyardError("invalid_request", "Invalid tool policy wait result");
      }
      keepWaiting = frame.method === "policy.status" && reply?.state === "pending";
      if (keepWaiting && decisionId) this.beginDecision(decisionId);
      this.session.replyAgent({
        type: "agent.result",
        requestId: frame.requestId,
        runtimeId: frame.runtimeId,
        bindingId: frame.bindingId,
        ok: true,
        result,
      });
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        if (decisionId && frame.method !== "policy.cancel") this.cancelDecision(decisionId);
        this.session.replyAgent({
          type: "agent.result",
          requestId: frame.requestId,
          runtimeId: frame.runtimeId,
          bindingId: frame.bindingId,
          ok: false,
          error: body(error),
        });
      }
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
      if (generation === this.generation && decisionId && !keepWaiting)
        this.endDecision(decisionId);
    }
  }

  /** Call only for human-origin session.prompt, never automated continuations/extension text. */
  async humanInput(options: AgentBrokerRequestOptions = {}): Promise<string> {
    if (this.closed) throw stale();
    const configuration = this.configuration
      ? structuredClone(this.configuration)
      : await this.ready({ ...options, require: "agentRequests" });
    const generation = this.generation;
    const humanInputId = randomUUID();
    // The helper appends switchyard-human-input before returning this receipt. The caller
    // must await us before sending a native prompt; no host-side transcript fabrication.
    await this.session.bridgeRequest(
      "input.human",
      { humanInputId },
      {
        ...options,
        timeoutMs: deadlineMs(options.timeoutMs ?? this.broker.timeoutMs),
      },
    );
    if (generation !== this.generation || configuration.bindingId !== this.configuration?.bindingId)
      throw stale();
    if (this.helloRecord) this.helloRecord.context = { humanInputId, causalMessageId: null };
    return humanInputId;
  }

  /** Local socket/extension loss requires a new hello; a network welcome cannot resurrect it. */
  lost(): void {
    if (this.closed) return;
    this.invalidate();
    this.helloRecord = null;
    this.configuration = null;
    if (this.state) this.publish("lost");
    this.notify();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lostBeforeClose();
    this.broker.forget(this);
  }

  /** Coordinator loss keeps the local fence for evidence queries, but never authorizes work. */
  disconnect(): void {
    if (this.closed) return;
    for (const controller of this.pending.keys())
      controller.abort(new SwitchyardError("host_unreachable", "Coordinator disconnected"));
    this.clearDecisions();
    if (this.configuration) {
      this.configuration.coordinatorConnected = false;
      if (this.state?.policyState === "active") this.publish("lost");
      const generation = this.generation;
      void this.session.bridgeRequest("connection.update", { connected: false }).catch((error) => {
        if (generation === this.generation) this.broker.report(error, this.sessionId);
      });
    }
    this.notify();
  }

  reconnect(): void {
    this.notify(); // Also wakes a startup bind waiting for its first welcome.
    if (this.closed || !this.helloRecord) return;
    if (this.syncing) return;
    void this.synchronize().catch((error) => this.broker.report(error, this.sessionId));
  }

  private async synchronize(): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.syncController = controller;
    this.failure = null;
    const timer = setTimeout(
      () =>
        controller.abort(
          new SwitchyardError("timeout", "Agent bridge startup/reconnection timed out"),
        ),
      this.broker.timeoutMs,
    );
    // Enforce the whole deadline even if an adapter forgets to implement cancellation.
    const attempt = async () => {
      const deadline = Date.now() + this.broker.timeoutMs;
      for (;;) {
        try {
          await this.bindAndConfigure(generation, controller.signal, deadline);
          return;
        } catch (error) {
          this.check(generation, controller.signal);
          if (!(error instanceof SwitchyardError) || error.code !== "host_unreachable") throw error;
          if (!this.broker.link.connected) await this.changed(deadline, controller.signal);
          else throw error;
        }
      }
    };
    const work = this.withSignal(attempt(), controller.signal);
    this.syncing = work;
    try {
      await work;
    } catch (error) {
      if (generation === this.generation) {
        this.failure = error;
        if (!this.configuration) this.publish("lost");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.syncing === work) this.syncing = null;
      if (this.syncController === controller) this.syncController = null;
      this.notify();
    }
  }

  private async bindAndConfigure(
    generation: number,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    const hello = this.helloRecord;
    if (!hello) throw stale();
    // An unconfirmed configure may already have replaced Pi's controller. A new attempt
    // therefore needs a new observable identity too, even with unchanged native/runtime IDs.
    if (!this.configuration && this.configurationAttempted) {
      this.controllerEpoch = randomUUID();
      this.configurationAttempted = false;
      this.publish("initializing");
    }
    while (!this.broker.link.connected) await this.changed(deadline, signal);
    this.check(generation, signal);
    const link = this.broker.link;
    let bind: z.infer<typeof BindResult>;
    if (!link.negotiatedFeatures.has("agentRequests.v1")) {
      // Old coordinator: disable the extension explicitly; do not emit an unknown global frame.
      bind = {
        version: 1,
        sessionId: this.sessionId,
        runtimeId: hello.runtimeId,
        nativeSessionId: hello.nativeSessionId,
        features: [],
        policyRequired: this.required,
        sessionUrl: null,
      };
    } else {
      let policyBoundary: HostPolicyBoundary | undefined;
      if (link.negotiatedFeatures.has("policies.v1") && hello.capabilities.toolPolicy) {
        this.check(generation, signal);
        try {
          const boundary = await this.withSignal(this.session.getPolicyBoundary(), signal);
          this.check(generation, signal);
          const parsed = HostPolicyBoundary.safeParse(boundary);
          if (!parsed.success) throw new Error("Invalid policy boundary");
          policyBoundary = parsed.data;
        } catch {
          this.check(generation, signal);
          throw new SwitchyardError(
            "forbidden",
            "Cannot verify workspace boundary for policy enforcement.",
          );
        }
      }
      this.check(generation, signal);
      const result = await link.requestAgent(
        this.sessionId,
        hello.nativeSessionId,
        hello.runtimeId,
        "session.bind",
        {
          version: 1,
          controllerEpoch: this.controllerEpoch,
          sessionFile: hello.sessionFile,
          mode: this.session.mode,
          capabilities: { ...hello.capabilities },
          policyRequired: this.required,
          ...(policyBoundary === undefined ? {} : { policyBoundary }),
        },
        { context: { ...hello.context }, signal, timeoutMs: this.remaining(deadline) },
      );
      this.check(generation, signal);
      const parsed = BindResult.safeParse(result);
      if (!parsed.success)
        throw new SwitchyardError("invalid_request", "Invalid session.bind result (A.1 required)");
      bind = parsed.data;
      if (
        bind.sessionId !== this.sessionId ||
        bind.runtimeId !== hello.runtimeId ||
        bind.nativeSessionId !== hello.nativeSessionId ||
        (this.required && !bind.policyRequired)
      )
        throw new SwitchyardError(
          "stale_control",
          "session.bind result substituted identity or protection",
        );
      // Current coordinator rules can strengthen the original launch requirement before
      // configure; an already-required runtime can never be downgraded.
      this.required ||= bind.policyRequired;
      const features = new Set(bind.features);
      if (
        features.size !== bind.features.length ||
        bind.features.some(
          (feature) =>
            !["agentRequests.v1", "policies.v1"].includes(feature) ||
            !link.negotiatedFeatures.has(feature),
        ) ||
        (features.has("policies.v1") &&
          (!features.has("agentRequests.v1") || !hello.capabilities.toolPolicy))
      )
        throw new SwitchyardError(
          "invalid_request",
          "session.bind returned unnegotiated bridge features",
        );
      if (features.has("policies.v1") && !bind.sessionUrl)
        throw new SwitchyardError(
          "invalid_request",
          "Protected binding requires its coordinator session URL",
        );
    }
    this.check(generation, signal);
    const previous = this.configuration;
    const sameConfiguration =
      previous &&
      previous.sessionId === bind.sessionId &&
      previous.runtimeId === bind.runtimeId &&
      previous.nativeSessionId === bind.nativeSessionId &&
      previous.policyRequired === bind.policyRequired &&
      previous.sessionUrl === bind.sessionUrl &&
      [...previous.features].sort().join() === [...bind.features].sort().join();
    if (sameConfiguration) {
      // Rebind centrally after coordinator restart, but resume the SAME local binding on a
      // mere network reconnect. A controller/socket reattachment always went through hello.
      await this.session.bridgeRequest(
        "connection.update",
        { connected: true },
        { signal, timeoutMs: this.remaining(deadline) },
      );
      this.check(generation, signal);
      if (!this.broker.link.connected)
        throw new SwitchyardError("host_unreachable", "Coordinator disconnected during reconnect");
      previous.coordinatorConnected = true;
      this.publish(this.policyActive(hello, bind.features) ? "active" : "unsupported");
    } else {
      if (previous) {
        // Negotiation/configuration changed during reconnect: this is NOT a mere
        // connection.update. Publish and centrally bind a fresh epoch before configure.
        for (const controller of this.pending.keys()) controller.abort(stale());
        this.clearDecisions();
        this.configuration = null;
        this.controllerEpoch = randomUUID();
        this.configurationAttempted = false;
        this.publish("initializing");
        return this.bindAndConfigure(generation, signal, deadline);
      }
      const configuration = {
        ...bind,
        features: [...bind.features],
        bindingId: randomUUID(),
        coordinatorConnected: true,
      };
      // No configuration or active state escapes until the *actual* local receipt is checked.
      this.configurationAttempted = true;
      const receipt = await this.session.configureAgent(configuration, {
        signal,
        timeoutMs: this.remaining(deadline),
      });
      this.check(generation, signal);
      if (!this.broker.link.connected)
        throw new SwitchyardError("host_unreachable", "Coordinator disconnected during configure");
      const parsed = Configured.safeParse(receipt);
      const active = this.policyActive(hello, bind.features);
      const agent = bind.features.includes("agentRequests.v1");
      if (
        !parsed.success ||
        parsed.data.agentTools !== (agent && hello.capabilities.agentTools) ||
        parsed.data.messageDelivery !==
          (agent && hello.capabilities.messageDelivery && hello.capabilities.editorDraftGuard) ||
        parsed.data.policyRequired !== this.required ||
        parsed.data.policyState !== (active ? "active" : "unsupported") ||
        parsed.data.policyPhases.length !== (active ? 2 : 0) ||
        (active &&
          (!parsed.data.policyPhases.includes("tool_call") ||
            !parsed.data.policyPhases.includes("request")))
      )
        throw new SwitchyardError("invalid_request", "Invalid or inconsistent configure receipt");
      this.configuration = configuration;
      this.publish(parsed.data.policyState);
    }
    this.notify();
    if (this.required && this.state?.policyState !== "active")
      throw new SwitchyardError(
        "unsupported_capability",
        "Required bridge policies are unavailable",
      );
  }

  private policyActive(hello: AgentBrokerHello, features: string[]): boolean {
    return (
      hello.capabilities.toolPolicy &&
      features.includes("agentRequests.v1") &&
      features.includes("policies.v1")
    );
  }
  private assertBinding(frame: AgentBrokerRequest): void {
    const configuration = this.configuration;
    if (
      this.closed ||
      !configuration ||
      frame.runtimeId !== configuration.runtimeId ||
      frame.nativeSessionId !== configuration.nativeSessionId ||
      frame.bindingId !== configuration.bindingId
    )
      throw stale();
  }
  private check(generation: number, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? stale();
    if (this.closed || generation !== this.generation) throw stale();
  }
  private remaining(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new SwitchyardError("timeout", "Agent bridge startup/reconnection timed out");
    return remaining;
  }
  private publish(policyState: AgentBrokerState["policyState"]): void {
    const hello = this.helloRecord;
    if (!hello) {
      if (this.state)
        this.state = {
          ...this.state,
          policyState,
          agentTools: false,
          messageDelivery: false,
          policyPhases: [],
        };
    } else {
      if (!this.controllerEpoch) throw stale();
      const features = this.configuration?.features ?? [];
      this.state = {
        version: 1,
        runtimeId: hello.runtimeId,
        nativeSessionId: hello.nativeSessionId,
        controllerEpoch: this.controllerEpoch,
        agentTools: features.includes("agentRequests.v1") && hello.capabilities.agentTools,
        messageDelivery:
          features.includes("agentRequests.v1") &&
          hello.capabilities.messageDelivery &&
          hello.capabilities.editorDraftGuard,
        policyState,
        policyPhases: policyState === "active" ? ["tool_call", "request"] : [],
      };
    }
    if (this.state) this.session.onState?.(structuredClone(this.state));
  }
  private beginDecision(id: string): void {
    const previous = this.decisions.get(id);
    clearTimeout(previous);
    // A healthy ASK/status response renews communication, not the human approval deadline.
    // No subsequent poll/response for 30 seconds means the client is no longer waiting.
    const timer = setTimeout(() => this.cancelDecision(id), MAX_WAIT_MS);
    timer.unref();
    this.decisions.set(id, timer);
    if (!previous) this.session.setPolicyWaiting(id, true);
  }
  private endDecision(id: string): void {
    const timer = this.decisions.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.decisions.delete(id);
    this.session.setPolicyWaiting(id, false);
  }
  private cancelDecision(id: string, notifyCoordinator = true): void {
    const waiting = this.decisions.has(id);
    this.endDecision(id);
    for (const [controller, decisionId] of this.pending) {
      if (decisionId === id)
        controller.abort(new SwitchyardError("conflict", "Policy wait canceled"));
    }
    const configuration = this.configuration;
    if (!waiting || !notifyCoordinator || !configuration) return;
    // Never reuse a canceled poll's signal/deadline, nor queue cancellation behind a turn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    timer.unref();
    void this.withSignal(
      this.broker.link.requestAgent(
        this.sessionId,
        configuration.nativeSessionId,
        configuration.runtimeId,
        "policy.cancel",
        { decisionId: id },
        {
          context: {
            ...(this.helloRecord?.context ?? { humanInputId: null, causalMessageId: null }),
          },
          signal: controller.signal,
          timeoutMs: 1000,
          deadlineAt: new Date(Date.now() + 1000).toISOString(),
        },
      ),
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
  private clearDecisions(): void {
    for (const id of this.decisions.keys()) this.cancelDecision(id);
  }
  private invalidate(): void {
    this.generation++;
    this.failure = null;
    this.syncController?.abort();
    this.syncController = null;
    this.syncing = null;
    for (const controller of this.pending.keys()) controller.abort();
    this.clearDecisions();
    this.notify();
  }
  private lostBeforeClose(): void {
    this.invalidate();
    this.helloRecord = null;
    this.configuration = null;
    if (this.state) this.publish("lost");
    this.notify();
  }
  private withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? stale());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private notify(): void {
    for (const wake of [...this.changes]) wake();
  }
  private changed(deadline: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? stale());
    const remaining = this.remaining(deadline);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.changes.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? stale());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SwitchyardError("timeout", "Agent bridge startup/reconnection timed out"));
      }, remaining);
      this.changes.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
