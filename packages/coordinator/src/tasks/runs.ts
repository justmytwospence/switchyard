import {
  type CheckResult,
  ChecksResult,
  MARKERS,
  type Run,
  type Session,
  type Task,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import type { SessionSettled } from "../event-hub.js";
import { getService } from "../services.js";
import { effectiveChecks, putTaskState, raiseFailed, saveRun, shortError } from "./common.js";

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

/** Which continuation limit is exhausted, or null. Token/cost caps apply only with accounting. */
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
  if (run.usage.accounting === "available") {
    if (l.maxTokens !== null && run.usage.tokens !== null && run.usage.tokens >= l.maxTokens) {
      return `the token limit of ${l.maxTokens}`;
    }
    if (l.maxCostUsd !== null && run.usage.costUsd !== null && run.usage.costUsd >= l.maxCostUsd) {
      return `the cost limit of $${l.maxCostUsd}`;
    }
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
/** Setting: a continuation persisted but not yet acknowledged by the host. */
const CONTINUATION_PREFIX = "runContinuation:";

interface PendingContinuation {
  n: number;
  text: string;
}

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
  /** A settle that arrived while its run was being evaluated: re-evaluated afterwards. */
  private deferred = new Map<
    string,
    Pick<SessionSettled, "session" | "aborted" | "lastAssistantText">
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
      if (e.type === "session.updated") this.mirror(e.data as Session);
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
   * middle. Checks and unacknowledged continuations are re-sent with their deterministic command
   * ids (the host returns the stored receipt if it already ran them); an idle session whose
   * settle was never evaluated under automation is evaluated now.
   */
  recover(hostId?: string): void {
    const { store, hostHub } = this.ctx;
    const runs = store.runs.list("state IN ('running', 'waiting_input', 'checking')");
    for (const run of runs) {
      if (!run.hostId || (hostId && run.hostId !== hostId)) continue;
      if (!hostHub.isConnected(run.hostId)) continue;
      if (run.controlMode !== "automation") continue;
      const task = store.tasks.get(run.taskId);
      if (!task || task.currentRunId !== run.id) continue;
      if (run.state === "checking") {
        if (!this.checking.has(run.id)) {
          void this.awaitChecks(run.id).catch((err) =>
            this.ctx.log.error({ err, runId: run.id }, "checks recovery failed"),
          );
        }
        continue;
      }
      if (this.continuing.has(run.id) || this.busy.has(run.id)) continue;
      const pending = store.getSetting<PendingContinuation | null>(
        CONTINUATION_PREFIX + run.id,
        null,
      );
      if (pending) {
        void this.sendContinuation(run.id, pending).catch((err) =>
          this.ctx.log.error({ err, runId: run.id }, "continuation recovery failed"),
        );
        continue;
      }
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session?.runtime !== "idle") continue;
      if (store.runSettleCount(run.id) === 0 || this.latestSettleEvaluated(run.id)) continue;
      void this.onSessionSettled({
        session,
        aborted: session.runtimeDetail === "aborted",
        lastAssistantText: session.lastAssistantText,
      }).catch((err) => this.ctx.log.error({ err, runId: run.id }, "settle recovery failed"));
    }
  }

  /** Whether the run's latest settle was already evaluated under automation. */
  private latestSettleEvaluated(runId: string): boolean {
    const { store } = this.ctx;
    return store.getSetting<number>(EVALUATED_PREFIX + runId, 0) === store.runSettleCount(runId);
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
      } else if (cur.state === "interrupted" && rt === "running") {
        // Resumed and working again.
        patch.state = "running";
        if (task && owns && task.state === "in_progress" && task.blocked) {
          putTaskState(this.ctx, task, task.state, { blocked: null });
        }
      }
      if (Object.keys(patch).length > 0) saveRun(this.ctx, cur, patch);
    });
  }

  /**
   * A session went idle. Evaluate the run: markers, continuation within limits, checks, Review.
   * Human control or an abort only records usage.
   */
  async onSessionSettled(s: Pick<SessionSettled, "session" | "aborted" | "lastAssistantText">) {
    const { store } = this.ctx;
    const session = store.sessions.get(s.session.id) ?? s.session;
    const run = this.runOf(session);
    if (!run || !EVALUATED.has(run.state)) return;
    if (this.busy.has(run.id)) {
      // Never drop a settle signal: evaluate it once the current evaluation finishes.
      this.deferred.set(run.id, s);
      return;
    }
    this.busy.add(run.id);
    try {
      const usage = usageFrom(session, run);
      const recorded = store.tx(() =>
        saveRun(this.ctx, store.runs.require(run.id), {
          usage,
          state: run.state === "waiting_input" ? "running" : run.state,
        }),
      );
      if (recorded.controlMode === "human") return;
      // The latest settle is evaluated under automation (recovery and deferred signals skip it).
      store.setSetting(EVALUATED_PREFIX + run.id, store.runSettleCount(run.id));
      if (s.aborted) return;
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
      this.busy.delete(run.id);
      this.runDeferred(run.id);
    }
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
    if (!run || (run.controlMode === "automation" && this.latestSettleEvaluated(run.id))) return;
    void this.onSessionSettled({ ...next, session }).catch((err) =>
      this.ctx.log.error({ err, sessionId: session.id }, "deferred run evaluation failed"),
    );
  }

  private isWatch(task: Task): boolean {
    if (task.origin.kind !== "automation") return false;
    return this.ctx.store.automations.get(task.origin.automationId)?.mode === "watch";
  }

  /**
   * Send the next continuation prompt; a `stale_control` receipt ends it silently. The
   * continuation is persisted (count and text) before it is sent with a deterministic command id,
   * so a coordinator restart re-sends the same command and the host dedupes it.
   */
  private async continueRun(runId: string, extra = ""): Promise<void> {
    const { store } = this.ctx;
    const pending = store.tx(() => {
      const run = store.runs.get(runId);
      if (run?.controlMode !== "automation" || !EVALUATED.has(run.state)) return null;
      if (!run.limits.enabled || !run.sessionId || !run.hostId) return null;
      const n = run.continuationsUsed + 1;
      saveRun(this.ctx, run, {
        continuationsUsed: n,
        state: "running",
        startedAt: run.startedAt ?? store.nowIso(),
      });
      const text = continuationPrompt(run.limits.objective, n, run.limits.maxContinuations, extra);
      const p: PendingContinuation = { n, text };
      store.setSetting(CONTINUATION_PREFIX + runId, p);
      return p;
    });
    if (!pending) return;
    await this.sendContinuation(runId, pending);
  }

  private async sendContinuation(runId: string, pending: PendingContinuation): Promise<void> {
    const { store, hostHub } = this.ctx;
    const run = store.runs.get(runId);
    if (!run?.hostId || !run.sessionId) return;
    this.continuing.add(runId);
    try {
      await hostHub.request(
        run.hostId,
        {
          type: "session.prompt",
          sessionId: run.sessionId,
          text: pending.text,
          images: [],
          mode: "prompt",
          origin: "automation",
          controlRevision: run.controlRevision,
        },
        { commandId: continuationCommandId(runId, pending.n) },
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
      store.deleteSetting(CONTINUATION_PREFIX + runId);
      if (e.code === "stale_control") {
        this.ctx.log.info({ runId }, "continuation superseded by takeover");
        return;
      }
      const cur = store.runs.get(runId);
      if (cur?.controlMode !== "automation") return;
      this.finishBlocked(runId, `Could not continue: ${e.message}`, "failed");
    } finally {
      this.continuing.delete(runId);
    }
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
      return { run: saveRun(this.ctx, run, { state: "checking" }), commands };
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
        saveRun(this.ctx, withChecks, { state: "running" });
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

  /** The run failed or the agent is blocked: task blocked plus `failed` attention. */
  finishBlocked(
    runId: string,
    reason: string,
    kind: "blocked" | "failed" = "blocked",
    checks?: CheckResult[],
  ): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.require(runId);
      saveRun(this.ctx, run, {
        state: "failed",
        endedAt: store.nowIso(),
        outcome: { kind, summary: reason },
        ...(checks ? { checks } : {}),
      });
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
