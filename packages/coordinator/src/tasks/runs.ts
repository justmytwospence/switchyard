import { isDeepStrictEqual } from "node:util";
import {
  type CheckResult,
  ChecksResult,
  MARKERS,
  type PolicyEvaluation,
  type Run,
  type Session,
  SwitchyardError,
  type Task,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import type { SessionSettled } from "../event-hub.js";
import { POLICY_LAUNCH_UNAVAILABLE } from "../policies/launch.js";
import type { PolicyService } from "../policies/service.js";
import { getService } from "../services.js";
import { pauseRunForPolicy } from "../sessions/control.js";
import { effectiveChecks, putTaskState, raiseFailed, saveRun, shortError } from "./common.js";
import {
  CANCELED_AUTHORIZATION_PREFIX,
  CANCELED_CONTINUATION_PREFIX,
  CONTINUATION_PAUSED_NOTICE,
  CONTINUATION_PREFIX,
  CONTINUATION_UNCERTAIN_NOTICE,
  type ContinuationSettlement,
  continuationContext,
  continuationSource,
  isUnspentContinuationAuthorization,
  matchesContinuation,
  type PendingContinuation,
  SETTLEMENT_PREFIX,
} from "./continuations.js";
import { isTerminalTask } from "./state.js";

export type Marker = { kind: "done" } | { kind: "blocked"; reason: string } | { kind: "no_change" };

export const ACCOUNTING_UNAVAILABLE_NOTE = "Token/cost accounting not reported by this Pi provider";

/** The last completion marker line in an assistant message, if any. */
export function parseMarker(text: string | null | undefined): Marker | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim().replace(/^[`*_>\s]+|[`*_\s]+$/g, "");
    if (line.startsWith(MARKERS.blocked)) {
      const reason = line
        .slice(MARKERS.blocked.length)
        .replace(/^[\s:\-–]+/, "")
        .trim();
      return { kind: "blocked", reason: reason || "The agent reported it is blocked" };
    }
    if (line.startsWith(MARKERS.noChange)) return { kind: "no_change" };
    if (line.startsWith(MARKERS.done)) return { kind: "done" };
  }
  return null;
}

export function continuationPrompt(objective: string, n: number, max: number, extra = ""): string {
  const base = `Continue working toward the objective: ${objective}. Continuation ${n} of ${max}. End with \`${MARKERS.done}\` when finished or \`${MARKERS.blocked} <reason>\`.`;
  return extra ? `${base}\n\n${extra}` : base;
}

/** Run usage from session stats (`accounting: unavailable` with a note when not reported). */
export function usageFrom(session: Session, run: Run): Run["usage"] {
  const stats = session.stats;
  if (stats && (stats.tokens !== null || stats.costUsd !== null)) {
    return { tokens: stats.tokens, costUsd: stats.costUsd, accounting: "available", note: null };
  }
  // No stats yet: keep what the run knows (host capabilities decide the initial accounting).
  if (!stats) return run.usage;
  return {
    tokens: null,
    costUsd: null,
    accounting: "unavailable",
    note: ACCOUNTING_UNAVAILABLE_NOTE,
  };
}

/** Unconditional continuation limits. Token/USD budgets are authorized by PolicyService. */
export function exceededLimit(run: Run, now: Date): string | null {
  const l = run.limits;
  if (!l.enabled) return "continuation is disabled";
  if (run.continuationsUsed >= l.maxContinuations) {
    return `the maximum of ${l.maxContinuations} continuation${l.maxContinuations === 1 ? "" : "s"}`;
  }
  const started = Date.parse(run.startedAt ?? run.createdAt);
  if (now.getTime() - started >= l.maxElapsedMinutes * 60_000) {
    return `the elapsed-time limit of ${l.maxElapsedMinutes} minute${l.maxElapsedMinutes === 1 ? "" : "s"}`;
  }
  return null;
}

/** States in which a settled session is evaluated for its run. */
const EVALUATED = new Set<Run["state"]>(["dispatching", "uncertain", "running", "waiting_input"]);

export interface RunsOptions {
  /** Timeout for `checks.run` (default 2 h). */
  checksTimeoutMs: number;
}

/** Setting: the settle count (`Store.runSettleCount`) last evaluated under automation. */
const EVALUATED_PREFIX = "runEvaluated:";

/**
 * Deterministic command ids: a resend after a coordinator restart dedupes on the host. Checks
 * include the control revision so checks re-run after a takeover and return are fresh.
 */
export function checksCommandId(
  run: Pick<Run, "id" | "attempt" | "continuationsUsed" | "controlRevision">,
): string {
  return `chk_${run.id}_${run.attempt}_${run.continuationsUsed}_${run.controlRevision}`;
}

export function continuationCommandId(runId: string, n: number): string {
  return `cont_${runId}_${n}`;
}

/** Whether `commandId` is one of this run's automated continuation or checks commands. */
export function isRunAutomationCommand(runId: string, commandId: string): boolean {
  return commandId.startsWith(`cont_${runId}_`) || commandId.startsWith(`chk_${runId}_`);
}

/**
 * Run lifecycle after launch: mirrors session runtime into the run, evaluates completion
 * markers when the session settles, continues within limits, runs acceptance checks and moves
 * the task to Review (or blocks it). Every automated step checks `controlMode` first.
 */
export class RunsService {
  private busy = new Set<string>();
  /** Approval updates can arrive while an earlier authorize call is still unwinding. */
  private recoveryRequested = new Set<string>();
  /** A readiness defer leaves the settle unevaluated; wait for a readiness event, not a loop. */
  private availabilityDeferred = new Set<string>();
  /** Runs whose session Stop is aborting right now. */
  private stopping = new Map<string, number>();
  /** A settle that arrived while its run was being evaluated: re-evaluated afterwards. */
  private deferred = new Map<
    string,
    Pick<SessionSettled, "session" | "aborted" | "lastAssistantText" | "watermark"> & {
      /** An explicit return may reevaluate the same settle under its new control identity. */
      controlRevision?: number;
    }
  >();
  /** Runs with a `checks.run` or continuation awaiting its receipt in this process. */
  private checking = new Set<string>();
  private continuing = new Set<string>();
  private stopped = false;
  private unsubscribe: (() => void)[] = [];

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: RunsOptions = { checksTimeoutMs: 2 * 3_600_000 },
  ) {}

  start(): void {
    const settled = (s: SessionSettled) => {
      void this.onSessionSettled(s).catch((err) =>
        this.ctx.log.error({ err, sessionId: s.session.id }, "run evaluation failed"),
      );
    };
    const event = (e: { type: string; data: unknown }) => {
      if (e.type === "session.updated") {
        const session = e.data as Session;
        this.mirror(session);
        // A welcome can precede the active bridge projection. Also recover reservations
        // whose earlier in-memory HostHub request expired while enforcement was away.
        if (session.bridge?.policyState === "active") this.recover(session.hostId);
      }
      // A decision owns the whole authorization, potentially several sequential ASK rules.
      if (e.type === "interaction.updated") this.recover();
    };
    // Ready-for-review attention resolves when the task leaves Review (any path).
    const taskChanged = ({ id, task }: { id: string; task: Task | null }) => {
      if (task?.state === "review") return;
      if (this.ctx.attention.open({ taskId: id, reason: "ready_for_review" }).length > 0) {
        this.ctx.attention.resolve({ taskId: id, reason: "ready_for_review" });
      }
    };
    const connected = ({ hostId }: { hostId: string }) => this.recover(hostId);
    this.ctx.hub.on("session.settled", settled);
    this.ctx.hub.on("event", event);
    this.ctx.hub.on("task.changed", taskChanged);
    this.ctx.hub.on("host.connected", connected);
    this.unsubscribe.push(
      () => this.ctx.hub.off("session.settled", settled),
      () => this.ctx.hub.off("event", event),
      () => this.ctx.hub.off("task.changed", taskChanged),
      () => this.ctx.hub.off("host.connected", connected),
    );
    this.recover();
  }

  /**
   * Recovery sweep (startup and every host connect): work a coordinator restart left in the
   * middle. Checks retain deterministic command ids. Unacknowledged continuations may be
   * re-sent with their original id only while the reserved authorization still holds; stale
   * reservations pause without querying a receipt by replay. Unevaluated idle settles run now.
   */
  recover(hostId?: string): void {
    if (this.stopped) return;
    const { store, hostHub } = this.ctx;
    const runs = store.runs.list("state IN ('running', 'waiting_input', 'checking')");
    for (const run of runs) {
      if (!run.hostId || (hostId && run.hostId !== hostId)) continue;
      if (run.controlMode !== "automation") continue;
      const task = store.tasks.get(run.taskId);
      if (!task || task.currentRunId !== run.id) continue;
      if (run.state === "checking") {
        if (hostHub.isConnected(run.hostId) && !this.checking.has(run.id)) {
          void this.awaitChecks(run.id).catch((err) =>
            this.ctx.log.error({ err, runId: run.id }, "checks recovery failed"),
          );
        }
        continue;
      }
      if (this.continuing.has(run.id) || this.busy.has(run.id)) {
        this.recoveryRequested.add(run.id);
        continue;
      }
      const pending = store.getSetting<PendingContinuation | null>(
        CONTINUATION_PREFIX + run.id,
        null,
      );
      if (pending) {
        this.busy.add(run.id);
        void this.resumeContinuation(run.id, pending)
          .catch((err) =>
            this.ctx.log.error({ err, runId: run.id }, "continuation recovery failed"),
          )
          .finally(() => {
            this.evaluationFinished(run.id);
          });
        continue;
      }
      if (!hostHub.isConnected(run.hostId)) continue;
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session?.runtime !== "idle" || session.compacting || !this.currentNonterminalRun(run))
        continue;
      if (store.runSettleCount(run.id) === 0 || this.latestSettleEvaluated(run.id)) continue;
      void this.onSessionSettled({
        session,
        aborted: session.runtimeDetail === "aborted",
        lastAssistantText: session.lastAssistantText,
        watermark: session.stats?.watermark,
      }).catch((err) => this.ctx.log.error({ err, runId: run.id }, "settle recovery failed"));
    }
  }

  /** Whether the run's latest settle was already evaluated under automation. */
  private latestSettleEvaluated(runId: string): boolean {
    const { store } = this.ctx;
    return store.getSetting<number>(EVALUATED_PREFIX + runId, 0) === store.runSettleCount(runId);
  }

  /** Stop is aborting this run: its aborted settle ends the turn and is not evaluated. Returns the release. */
  beginStop(runId: string): () => void {
    this.stopping.set(runId, (this.stopping.get(runId) ?? 0) + 1);
    return () => {
      const n = (this.stopping.get(runId) ?? 1) - 1;
      if (n <= 0) this.stopping.delete(runId);
      else this.stopping.set(runId, n);
    };
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  private runOf(session: Session): Run | undefined {
    const run = session.runId ? this.ctx.store.runs.get(session.runId) : undefined;
    return run && run.sessionId === session.id ? run : undefined;
  }

  /** Keep the run's state and usage in line with its session's runtime. */
  mirror(session: Session): void {
    const run = this.runOf(session);
    if (!run) return;
    const { store } = this.ctx;
    store.tx(() => {
      const cur = store.runs.get(run.id);
      if (!cur) return;
      const patch: Partial<Run> = {};
      const usage = usageFrom(session, cur);
      if (JSON.stringify(usage) !== JSON.stringify(cur.usage)) patch.usage = usage;
      const task = store.tasks.get(cur.taskId);
      const owns = task?.currentRunId === cur.id;
      const rt = session.runtime;
      if (cur.state === "running" && rt === "waiting_input") patch.state = "waiting_input";
      else if (cur.state === "waiting_input" && (rt === "running" || rt === "idle")) {
        patch.state = "running";
      } else if (
        (cur.state === "running" || cur.state === "waiting_input") &&
        (rt === "interrupted" || rt === "stopped")
      ) {
        patch.state = "interrupted";
        if (task && owns) {
          putTaskState(this.ctx, task, task.state, {
            blocked: { reason: "Session interrupted: resume to continue" },
          });
        }
      } else if ((cur.state === "running" || cur.state === "waiting_input") && rt === "failed") {
        const reason = `Session failed${session.runtimeDetail ? `: ${session.runtimeDetail}` : ""}`;
        patch.state = "failed";
        patch.endedAt = store.nowIso();
        patch.outcome = { kind: "failed", summary: reason };
        if (task && owns) {
          const blocked = putTaskState(this.ctx, task, task.state, { blocked: { reason } });
          raiseFailed(this.ctx, blocked, reason);
          this.recordAutomationOutcome(blocked, `Failed: ${reason}`, true);
        }
      } else if (
        cur.state === "interrupted" &&
        !(cur.controlMode === "human" && cur.outcome?.kind === "blocked") &&
        rt === "running" &&
        !(task && isTerminalTask(task.state))
      ) {
        // Resumed and working again.
        patch.state = "running";
        if (task && owns && task.state === "in_progress" && task.blocked) {
          putTaskState(this.ctx, task, task.state, { blocked: null });
        }
      }
      if (Object.keys(patch).length > 0)
        saveRun(
          this.ctx,
          cur,
          patch,
          patch.state === "failed" ? { completion: "final_failure" } : {},
        );
    });
  }

  /**
   * A session went idle. Evaluate the run: markers, continuation within limits, checks, Review.
   * Human control only records usage; an aborted turn is evaluated like any other.
   */
  async onSessionSettled(
    s: Pick<SessionSettled, "session" | "aborted" | "lastAssistantText" | "watermark">,
  ) {
    const { store } = this.ctx;
    const session = store.sessions.get(s.session.id) ?? s.session;
    const run = this.runOf(session);
    if (
      !run ||
      !EVALUATED.has(run.state) ||
      session.runtime !== "idle" ||
      session.compacting ||
      !this.currentNonterminalRun(run)
    )
      return;
    if (this.busy.has(run.id)) {
      // Never drop a settle signal: evaluate it once the current evaluation finishes.
      this.deferred.set(run.id, s);
      return;
    }
    this.busy.add(run.id);
    try {
      // Do not erase an ASK (or a counted reservation) when a newer settle arrives.
      // Cleanup requests normal recovery only after this evaluation releases its guard.
      const pending = store.getSetting<PendingContinuation | null>(
        CONTINUATION_PREFIX + run.id,
        null,
      );
      if (pending && run.controlMode === "automation") {
        if (run.controlRevision !== pending.input?.expectedControlRevision)
          this.deferred.set(run.id, { ...s, controlRevision: run.controlRevision });
        await this.resumeContinuation(run.id, pending);
        return;
      }
      const usage = usageFrom(session, run);
      const recorded = store.tx(() =>
        saveRun(this.ctx, store.runs.require(run.id), {
          usage,
          state: run.state === "waiting_input" ? "running" : run.state,
        }),
      );
      if (recorded.controlMode === "human") return;
      // Capture this settlement before any worker/check await. Mark it evaluated only when
      // its next action is durable, so a crash before preparing that action can recover it.
      const count = store.runSettleCount(run.id);
      const previous = store.getSetting<ContinuationSettlement | null>(
        SETTLEMENT_PREFIX + run.id,
        null,
      );
      store.setSetting(SETTLEMENT_PREFIX + run.id, {
        count,
        // Returning control can reevaluate the same durable settle without a new host event.
        // A different settlement count must never inherit that previous accounting evidence.
        watermark: s.watermark ?? (previous?.count === count ? previous.watermark : null),
      } satisfies ContinuationSettlement);
      // An aborted turn is evaluated like any settle (continuations count, checks run): pressing Esc
      // in Pi does not pause automation. To stop automation, use Stop (ends the run) or Take over
      // (pauses it). Only Stop's own abort is skipped here; stopSession then interrupts the run.
      if (s.aborted && this.stopping.has(run.id)) {
        store.setSetting(EVALUATED_PREFIX + run.id, count);
        return;
      }
      const task = store.tasks.get(run.taskId);
      if (!task || task.currentRunId !== run.id) return;
      const marker = parseMarker(s.lastAssistantText ?? session.lastAssistantText);
      if (marker?.kind === "blocked") {
        this.finishBlocked(run.id, marker.reason);
        return;
      }
      if (marker?.kind === "no_change" && this.isWatch(task)) {
        this.finishNoChange(run.id);
        return;
      }
      if (marker?.kind === "done" || marker?.kind === "no_change" || !recorded.limits.enabled) {
        await this.runChecks(run.id);
        return;
      }
      const exceeded = exceededLimit(recorded, store.now());
      if (exceeded) {
        this.finishBlocked(
          run.id,
          `Continuation limit reached (${exceeded}) without the agent reporting done`,
        );
        return;
      }
      await this.continueRun(run.id);
    } finally {
      this.evaluationFinished(run.id);
    }
  }

  private evaluationFinished(runId: string): void {
    this.busy.delete(runId);
    this.runDeferred(runId);
    const requested = this.recoveryRequested.delete(runId);
    const availabilityDeferred = this.availabilityDeferred.delete(runId);
    const run = this.ctx.store.runs.get(runId);
    // A restart may encounter an old pending authorization before evaluating a newer settle.
    // Discarding that stale proof must not strand the newer, still-unevaluated settlement.
    const unevaluated =
      (run?.state === "running" || run?.state === "waiting_input") &&
      !this.latestSettleEvaluated(runId);
    if (!this.stopped && run?.hostId && (requested || (unevaluated && !availabilityDeferred)))
      this.recover(run.hostId);
  }

  /** Re-evaluate a settle that arrived during an evaluation, if it is still unevaluated. */
  private runDeferred(runId: string): void {
    const next = this.deferred.get(runId);
    if (!next || this.stopped) return;
    this.deferred.delete(runId);
    const session = this.ctx.store.sessions.get(next.session.id);
    if (session?.runtime !== "idle") return;
    const run = this.runOf(session);
    // Only a settle not yet evaluated under automation (a human-control evaluation or a newer
    // settle); otherwise it would double the step the current evaluation just took.
    if (
      !run ||
      (run.controlMode === "automation" &&
        this.latestSettleEvaluated(run.id) &&
        next.controlRevision !== run.controlRevision)
    )
      return;
    void this.onSessionSettled({
      session,
      aborted: next.aborted || session.runtimeDetail === "aborted",
      lastAssistantText: session.lastAssistantText,
      watermark: session.stats?.watermark,
    }).catch((err) =>
      this.ctx.log.error({ err, sessionId: session.id }, "deferred run evaluation failed"),
    );
  }

  /** A stale wait must never revive a stopped run, replaced attempt or terminal ancestor. */
  private currentNonterminalRun(run: Run): boolean {
    const { store } = this.ctx;
    let task = store.tasks.get(run.taskId);
    if (!task || task.currentRunId !== run.id) return false;
    const seen = new Set<string>();
    while (task) {
      if (seen.has(task.id) || isTerminalTask(task.state)) return false;
      seen.add(task.id);
      if (!task.parentTaskId) return true;
      task = store.tasks.get(task.parentTaskId);
      if (!task) return false;
    }
    return false;
  }

  private isWatch(task: Task): boolean {
    if (task.origin.kind !== "automation") return false;
    return this.ctx.store.automations.get(task.origin.automationId)?.mode === "watch";
  }

  private policies(): PolicyService | undefined {
    return getService(this.ctx, "policies");
  }

  /** Availability is not authority: a same-controller outage preserves unspent ASK/ALLOW. */
  private continuationHostReady(runId: string, pending?: PendingContinuation): boolean {
    const run = this.ctx.store.runs.get(runId);
    const policies = this.policies();
    if (!run?.sessionId || !run.hostId || !policies) return false;
    const source =
      pending?.source ?? continuationSource(this.ctx.store.sessions.get(run.sessionId));
    try {
      if (!source)
        throw new SwitchyardError(
          pending ? "stale_control" : "unsupported_capability",
          POLICY_LAUNCH_UNAVAILABLE,
        );
      if (policies.checkContinuationAvailability(runId, source).state === "defer") {
        this.availabilityDeferred.add(runId);
        return false;
      }
      return true;
    } catch (err) {
      const error = shortError(err);
      if (error.code === "stale_control" && pending) {
        if (!this.discardContinuationAuthorization(runId, pending, error.message))
          void this.cancelContinuation(runId, error.message);
        return false;
      }
      this.ctx.store.deleteSetting(CONTINUATION_PREFIX + runId);
      this.finishBlocked(runId, error.message);
      return false;
    }
  }

  /** Persist the settlement's authorization before evaluating it; ASK never spends a step. */
  private async continueRun(runId: string, extra = ""): Promise<void> {
    const { store } = this.ctx;
    const policies = this.policies();
    if (!policies) {
      this.finishBlocked(runId, "Policy authorization is unavailable; continuation was blocked.");
      return;
    }
    if (!this.continuationHostReady(runId)) return;
    const pending = store.tx(() => {
      const run = store.runs.get(runId);
      if (
        run?.controlMode !== "automation" ||
        (!EVALUATED.has(run.state) && run.state !== "checking")
      )
        return null;
      if (!run.limits.enabled || !run.sessionId || !run.hostId) return null;
      const settlement = store.getSetting<ContinuationSettlement | null>(
        SETTLEMENT_PREFIX + runId,
        null,
      );
      if (!settlement) return null;
      const source = continuationSource(store.sessions.get(run.sessionId));
      if (!source) {
        this.finishBlocked(runId, "Policy enforcement requires a current controller identity.");
        return null;
      }
      const n = run.continuationsUsed + 1;
      const current = saveRun(this.ctx, run, { state: "running" });
      const p: PendingContinuation = {
        version: 3,
        source,
        phase: "authorization",
        deliveryAttempt: "not_sent",
        input: {
          kind: "continuation",
          runId,
          expectedControlRevision: run.controlRevision,
          nextContinuationNumber: n,
          expectedSettleCount: settlement.count,
          expectedWatermark: settlement.watermark,
        },
        context: continuationContext(store, policies, current),
        n,
        text: continuationPrompt(run.limits.objective, n, run.limits.maxContinuations, extra),
        decisionId: null,
      };
      store.setSetting(CONTINUATION_PREFIX + runId, p);
      store.setSetting(EVALUATED_PREFIX + runId, settlement.count);
      return p;
    });
    if (pending) await this.resumeContinuation(runId, pending);
  }

  private async resumeContinuation(runId: string, pending: PendingContinuation): Promise<void> {
    const { store } = this.ctx;
    const policies = this.policies();
    if (this.stopped) return;
    // Legacy persisted prompts have no authorization proof; do not grandfather them in.
    if (pending.version !== 3 || !policies) {
      if (
        !this.discardContinuationAuthorization(
          runId,
          pending,
          "Legacy or unavailable continuation authorization",
        )
      )
        await this.cancelContinuation(runId, "Legacy or unavailable continuation authorization");
      return;
    }
    if (pending.phase === "delivery") {
      await this.sendContinuation(runId, pending);
      return;
    }
    const run = store.runs.get(runId);
    if (!run || !matchesContinuation(store, policies, run, pending)) {
      if (
        !this.discardContinuationAuthorization(runId, pending, "Continuation authorization changed")
      )
        await this.cancelContinuation(runId, "Continuation authorization changed");
      return;
    }
    // Stable fences above take precedence over transport/bridge availability. A supported
    // welcome can arrive before the same controller's active projection.
    if (!this.continuationHostReady(runId, pending)) return;
    let result: PolicyEvaluation;
    try {
      result = await policies.authorize(pending.input);
    } catch (err) {
      if (this.stopped) return;
      const e = shortError(err);
      const current = store.runs.get(runId);
      const obsolete = !current || !matchesContinuation(store, policies, current, pending);
      const discarded = this.discardContinuationAuthorization(runId, pending, e.message);
      if (!discarded) await this.cancelContinuation(runId, e.message);
      else if (
        discarded === "discarded" &&
        !obsolete &&
        e.code !== "stale_control" &&
        e.code !== "conflict"
      )
        this.finishBlocked(runId, `Could not authorize continuation: ${e.message}`);
      return;
    }
    if (this.stopped) return;
    const current = store.runs.get(runId);
    const durable = store.getSetting<PendingContinuation | null>(CONTINUATION_PREFIX + runId, null);
    if (
      !current ||
      !isDeepStrictEqual(durable, pending) ||
      !matchesContinuation(store, policies, current, pending)
    ) {
      if (
        !this.discardContinuationAuthorization(runId, pending, "Continuation authorization changed")
      )
        await this.cancelContinuation(runId, "Continuation authorization changed");
      return;
    }
    // Recheck after the worker/approval mutex, never while PolicyService is answering ASK.
    const limit = exceededLimit(current, store.now());
    if (limit) {
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      this.finishBlocked(
        runId,
        `Continuation limit reached (${limit}) without the agent reporting done`,
      );
      return;
    }
    if (result.verdict === "ASK") {
      store.setSetting(CONTINUATION_PREFIX + runId, { ...pending, decisionId: result.decisionId });
      return;
    }
    if (result.verdict === "DENY") {
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      this.finishBlocked(runId, result.reason);
      return;
    }
    if (!this.continuationHostReady(runId, pending)) return;
    // No await between the final fences, unconditional limits and durable reservation.
    const delivery: PendingContinuation = {
      ...pending,
      phase: "delivery",
      deliveryAttempt: "not_sent",
    };
    try {
      store.tx(() => {
        // The asynchronous evaluator's ALLOW is not execution authority by itself. Rebuild
        // its proof under this transaction before spending a step or reserving delivery.
        policies.assertAuthorized(pending.input);
        saveRun(this.ctx, current, {
          continuationsUsed: pending.n,
          startedAt: current.startedAt ?? store.nowIso(),
        });
        store.setSetting(CONTINUATION_PREFIX + runId, delivery);
      });
    } catch (err) {
      const e = shortError(err);
      const discarded = this.discardContinuationAuthorization(runId, pending, e.message);
      if (!discarded) await this.cancelContinuation(runId, e.message);
      else if (discarded === "discarded" && e.code !== "stale_control" && e.code !== "conflict")
        this.finishBlocked(runId, `Could not authorize continuation: ${e.message}`);
      return;
    }
    await this.sendContinuation(runId, delivery);
  }

  private async sendContinuation(runId: string, pending: PendingContinuation): Promise<void> {
    const { store, hostHub } = this.ctx;
    const run = store.runs.get(runId);
    if (this.stopped) return;
    if (!run?.hostId || !run.sessionId) {
      await this.cancelContinuation(runId, "Continuation source is no longer available");
      return;
    }
    const check = (markAttempt: boolean): undefined | { defer: true; reason: string } => {
      // This is also HostHub's reconnect boundary. Re-read the actual reservation,
      // not this closure's proof, and commit ambiguity only at the external write.
      try {
        return store.tx(() => {
          const durable = store.getSetting<PendingContinuation | null>(
            CONTINUATION_PREFIX + runId,
            null,
          );
          const current = store.runs.get(runId);
          const policies = this.policies();
          if (
            this.stopped ||
            !durable ||
            durable.version !== 3 ||
            durable.phase !== "delivery" ||
            durable.n !== pending.n ||
            durable.text !== pending.text ||
            durable.context !== pending.context ||
            JSON.stringify(durable.input) !== JSON.stringify(pending.input) ||
            JSON.stringify(durable.source) !== JSON.stringify(pending.source) ||
            !current ||
            !policies ||
            !matchesContinuation(store, policies, current, durable)
          )
            throw new SwitchyardError("stale_control", "Continuation reservation changed");
          const limit = exceededLimit(
            { ...current, continuationsUsed: durable.n - 1 },
            store.now(),
          );
          if (limit) throw new SwitchyardError("stale_control", `Continuation limit: ${limit}`);
          const readiness = policies.checkReservedContinuation(durable.input, durable.context);
          if (readiness.state === "defer") return { defer: true, reason: readiness.reason };
          if (markAttempt)
            store.setSetting(CONTINUATION_PREFIX + runId, {
              ...durable,
              deliveryAttempt: "may_have_sent",
            } satisfies PendingContinuation);
        });
      } catch (err) {
        // A known downgrade is permanent too, but retain its upgrade diagnostic. All
        // other proof failures must pause, never become an ordinary execution failure.
        const error = shortError(err);
        throw new SwitchyardError(
          error.code === "unsupported_capability" ? error.code : "stale_control",
          error.message,
        );
      }
    };
    this.continuing.add(runId);
    try {
      // HostHub may reject an offline request without invoking its write guard. Validate
      // durable authority first so root/ALLOW/controller changes still pause while offline.
      if (check(false)?.defer) return;
      await hostHub.request(
        run.hostId,
        {
          type: "session.prompt",
          sessionId: run.sessionId,
          text: pending.text,
          images: [],
          mode: "prompt",
          origin: "automation",
          controlRevision: pending.input.expectedControlRevision,
        },
        {
          commandId: continuationCommandId(runId, pending.n),
          beforeSend: () => check(true),
        },
      );
      store.deleteSetting(CONTINUATION_PREFIX + runId);
    } catch (err) {
      if (this.stopped) return;
      const e = shortError(err);
      if ((e.details as { withdrawn?: boolean } | undefined)?.withdrawn) {
        // Withdrawn by a takeover while the host was away: never re-send it.
        store.deleteSetting(CONTINUATION_PREFIX + runId);
        return;
      }
      if (e.code === "host_unreachable" || e.code === "timeout") {
        // Unacknowledged: the recovery sweep re-sends it when the host is back.
        return;
      }
      if (e.code === "stale_control" || e.code === "unsupported_capability") {
        await this.cancelContinuation(runId, e.message);
        return;
      }
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      const cur = store.runs.get(runId);
      if (cur?.controlMode !== "automation") return;
      this.finishBlocked(runId, `Could not continue: ${e.message}`, "failed");
    } finally {
      this.continuing.delete(runId);
    }
  }

  /**
   * Compare-and-delete only a provably unspent wait. Cancellation and its worker fence join
   * the same transaction; none of this is a takeover or evidence of an uncertain delivery.
   * A replacement must be recovered in its actual phase, not altered by the obsolete caller.
   */
  private discardContinuationAuthorization(
    runId: string,
    expectedPending: PendingContinuation,
    reason: string,
  ): "discarded" | "replaced" | false {
    const { store } = this.ctx;
    return store.tx(() => {
      const pending = store.getSetting<PendingContinuation | null>(
        CONTINUATION_PREFIX + runId,
        null,
      );
      if (!isDeepStrictEqual(pending, expectedPending)) {
        this.recoveryRequested.add(runId);
        return "replaced";
      }
      if (!pending || !isUnspentContinuationAuthorization(store.runs.get(runId), runId, pending))
        return false;
      store.setSetting(
        `${CANCELED_AUTHORIZATION_PREFIX}${runId}:${pending.n}:${pending.input.expectedControlRevision}:${pending.input.expectedSettleCount}`,
        { reason, at: store.nowIso() },
      );
      this.policies()?.cancelContinuationAuthorization(pending.input, reason);
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      this.recoveryRequested.add(runId);
      return "discarded";
    });
  }

  /** Never refund/reuse a reserved count or reinterpret old authority as a new action. */
  private async cancelContinuation(runId: string, reason: string): Promise<void> {
    const { store } = this.ctx;
    const paused = store.tx(() => {
      const pending = store.getSetting<PendingContinuation | null>(
        CONTINUATION_PREFIX + runId,
        null,
      );
      if (!pending) return null;
      // Only an explicit not_sent fence proves no write was attempted. A v2 record can
      // retain that fence even though its original controller authority is unprovable.
      const mayHaveSent = pending.deliveryAttempt !== "not_sent";
      const notice = mayHaveSent
        ? `${CONTINUATION_PAUSED_NOTICE} ${CONTINUATION_UNCERTAIN_NOTICE}`
        : CONTINUATION_PAUSED_NOTICE;
      store.setSetting(`${CANCELED_CONTINUATION_PREFIX}${runId}:${pending.n}`, {
        commandId: continuationCommandId(runId, pending.n),
        reason,
        mayHaveSent,
        at: store.nowIso(),
      });
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      // The helper joins this transaction and propagates control/withdrawal only after commit.
      return { completion: pauseRunForPolicy(this.ctx, runId, notice) };
    });
    await paused?.completion;
  }

  /** Run acceptance checks (task, else project); none means straight to Review. */
  private async runChecks(runId: string): Promise<void> {
    const { store } = this.ctx;
    const prepared = store.tx(() => {
      const run = store.runs.get(runId);
      if (run?.controlMode !== "automation" || !EVALUATED.has(run.state)) return null;
      const task = store.tasks.require(run.taskId);
      const commands = effectiveChecks(this.ctx, task);
      if (commands.length === 0) return { run, commands };
      const checking = saveRun(this.ctx, run, { state: "checking" });
      store.setSetting(EVALUATED_PREFIX + runId, store.runSettleCount(runId));
      return { run: checking, commands };
    });
    if (!prepared) return;
    const { commands } = prepared;
    if (commands.length === 0) {
      this.finishSucceeded(runId, []);
      return;
    }
    await this.awaitChecks(runId);
  }

  /**
   * Send `checks.run` for a run in `checking` (again after a coordinator restart: the command id
   * is deterministic, so the host returns its stored result or joins the running checks) and
   * apply the results.
   */
  private async awaitChecks(runId: string): Promise<void> {
    const { store, hostHub } = this.ctx;
    const run = store.runs.get(runId);
    if (run?.state !== "checking" || !run.hostId || this.checking.has(runId)) return;
    const commands = effectiveChecks(this.ctx, store.tasks.require(run.taskId));
    const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
    let results: CheckResult[];
    this.checking.add(runId);
    try {
      const raw = await hostHub.request(
        run.hostId,
        { type: "checks.run", sessionId: run.sessionId!, path: session?.cwd ?? "", commands },
        { timeoutMs: this.opts.checksTimeoutMs, commandId: checksCommandId(run) },
      );
      results = ChecksResult.parse(raw).results;
    } catch (err) {
      if (this.stopped) return;
      const e = shortError(err);
      const cur = store.runs.get(runId);
      if (cur?.state !== "checking") return;
      if (cur.controlMode === "human") {
        store.tx(() => saveRun(this.ctx, cur, { state: "running" }));
        return;
      }
      this.finishBlocked(runId, `Checks could not run: ${e.message}`, "failed");
      return;
    } finally {
      this.checking.delete(runId);
    }
    if (this.stopped) return;
    const next = store.tx(() => {
      const cur = store.runs.get(runId);
      if (cur?.state !== "checking") {
        if (cur) saveRun(this.ctx, cur, { checks: results });
        return "done" as const;
      }
      if (cur.controlMode === "human") {
        saveRun(this.ctx, cur, { checks: results, state: "running" });
        return "done" as const;
      }
      const failing = results.filter((r) => r.exitCode !== 0);
      if (failing.length === 0) return "succeeded" as const;
      const withChecks = saveRun(this.ctx, cur, { checks: results });
      if (withChecks.limits.enabled && !exceededLimit(withChecks, store.now())) {
        // Keep checking durable until continueRun atomically prepares its authorization.
        return "continue" as const;
      }
      return "failed" as const;
    });
    if (next === "succeeded") this.finishSucceeded(runId, results);
    else if (next === "failed") {
      const first = results.find((r) => r.exitCode !== 0)!;
      this.finishBlocked(runId, `Checks failed: ${first.command}`, "failed", results);
    } else if (next === "continue") {
      const tails = results
        .filter((r) => r.exitCode !== 0)
        .map((r) => `\`${r.command}\` exited ${r.exitCode ?? "abnormally"}:\n${r.outputTail}`)
        .join("\n\n");
      await this.continueRun(runId, `The acceptance checks failed. Fix them:\n\n${tails}`);
    }
  }

  /** Checks passed (or none): Review with attention, or Done when review is not required. */
  private finishSucceeded(runId: string, checks: CheckResult[]): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.get(runId);
      if (!run) return;
      const task = store.tasks.require(run.taskId);
      const review = task.policy.completion.requireHumanReview;
      saveRun(this.ctx, run, {
        state: "succeeded",
        endedAt: store.nowIso(),
        checks,
        outcome: {
          kind: "review",
          summary: review ? "Ready for review" : "Completed; review not required",
        },
      });
      if (task.currentRunId !== run.id) return;
      if (review) {
        const next = putTaskState(this.ctx, task, "review", { blocked: null });
        this.ctx.attention.raise({
          reason: "ready_for_review",
          taskId: next.id,
          sessionId: next.sessionId,
          projectId: next.projectId,
          summary: next.title,
        });
        this.recordAutomationOutcome(next, "Ready for review", false);
      } else {
        const next = putTaskState(this.ctx, task, "done", { blocked: null });
        this.recordAutomationOutcome(next, "Done", false);
      }
    });
  }

  private finishNoChange(runId: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.require(runId);
      const task = store.tasks.require(run.taskId);
      saveRun(this.ctx, run, {
        state: "succeeded",
        endedAt: store.nowIso(),
        outcome: { kind: "no_change", summary: "No change" },
      });
      const next = putTaskState(this.ctx, task, "done", { blocked: null, hiddenFromBoard: true });
      this.recordAutomationOutcome(next, "No change", false);
    });
  }

  /**
   * The run failed or the agent is blocked: task blocked plus `failed` attention. A run that
   * already ended (stopped, finished) while the failing step was in flight is left alone.
   */
  finishBlocked(
    runId: string,
    reason: string,
    kind: "blocked" | "failed" = "blocked",
    checks?: CheckResult[],
  ): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.require(runId);
      if (!EVALUATED.has(run.state) && run.state !== "checking") return;
      saveRun(
        this.ctx,
        run,
        {
          state: "failed",
          endedAt: store.nowIso(),
          outcome: { kind, summary: reason },
          ...(checks ? { checks } : {}),
        },
        { completion: "final_failure" },
      );
      const task = store.tasks.require(run.taskId);
      if (task.currentRunId !== run.id) return;
      const blocked = putTaskState(this.ctx, task, task.state, { blocked: { reason } });
      raiseFailed(this.ctx, blocked, reason);
      this.recordAutomationOutcome(
        blocked,
        `${kind === "blocked" ? "Blocked" : "Failed"}: ${reason}`,
        true,
      );
    });
  }

  private recordAutomationOutcome(task: Task, outcome: string, failed: boolean): void {
    getService(this.ctx, "automations")?.recordOutcome(task, outcome, failed);
  }
}
