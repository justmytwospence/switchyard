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

/**
 * Run lifecycle after launch: mirrors session runtime into the run, evaluates completion
 * markers when the session settles, continues within limits, runs acceptance checks and moves
 * the task to Review (or blocks it). Every automated step checks `controlMode` first.
 */
export class RunsService {
  private busy = new Set<string>();
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
    this.ctx.hub.on("session.settled", settled);
    this.ctx.hub.on("event", event);
    this.ctx.hub.on("task.changed", taskChanged);
    this.unsubscribe.push(
      () => this.ctx.hub.off("session.settled", settled),
      () => this.ctx.hub.off("event", event),
      () => this.ctx.hub.off("task.changed", taskChanged),
    );
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
    if (this.busy.has(run.id)) return;
    this.busy.add(run.id);
    try {
      const usage = usageFrom(session, run);
      const recorded = store.tx(() =>
        saveRun(this.ctx, store.runs.require(run.id), {
          usage,
          state: run.state === "waiting_input" ? "running" : run.state,
        }),
      );
      if (recorded.controlMode === "human" || s.aborted) return;
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
    }
  }

  private isWatch(task: Task): boolean {
    if (task.origin.kind !== "automation") return false;
    return this.ctx.store.automations.get(task.origin.automationId)?.mode === "watch";
  }

  /** Send the next continuation prompt; a `stale_control` receipt ends it silently. */
  private async continueRun(runId: string, extra = ""): Promise<void> {
    const { store, hostHub } = this.ctx;
    const prepared = store.tx(() => {
      const run = store.runs.get(runId);
      if (run?.controlMode !== "automation" || !EVALUATED.has(run.state)) return null;
      if (!run.limits.enabled || !run.sessionId || !run.hostId) return null;
      const n = run.continuationsUsed + 1;
      const saved = saveRun(this.ctx, run, {
        continuationsUsed: n,
        state: "running",
        startedAt: run.startedAt ?? store.nowIso(),
      });
      const text = continuationPrompt(run.limits.objective, n, run.limits.maxContinuations, extra);
      return { run: saved, text };
    });
    if (!prepared) return;
    const { run, text } = prepared;
    try {
      await hostHub.request(run.hostId!, {
        type: "session.prompt",
        sessionId: run.sessionId!,
        text,
        images: [],
        mode: "prompt",
        origin: "automation",
        controlRevision: run.controlRevision,
      });
    } catch (err) {
      if (this.stopped) return;
      const e = shortError(err);
      if (e.code === "stale_control") {
        this.ctx.log.info({ runId }, "continuation superseded by takeover");
        return;
      }
      const cur = store.runs.get(runId);
      if (cur?.controlMode !== "automation") return;
      this.finishBlocked(runId, `Could not continue: ${e.message}`, "failed");
    }
  }

  /** Run acceptance checks (task, else project); none means straight to Review. */
  private async runChecks(runId: string): Promise<void> {
    const { store, hostHub } = this.ctx;
    const prepared = store.tx(() => {
      const run = store.runs.get(runId);
      if (run?.controlMode !== "automation" || !EVALUATED.has(run.state)) return null;
      const task = store.tasks.require(run.taskId);
      const commands = effectiveChecks(this.ctx, task);
      if (commands.length === 0) return { run, commands };
      return { run: saveRun(this.ctx, run, { state: "checking" }), commands };
    });
    if (!prepared) return;
    const { run, commands } = prepared;
    if (commands.length === 0) {
      this.finishSucceeded(runId, []);
      return;
    }
    const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
    let results: CheckResult[];
    try {
      const raw = await hostHub.request(
        run.hostId!,
        { type: "checks.run", sessionId: run.sessionId!, path: session?.cwd ?? "", commands },
        { timeoutMs: this.opts.checksTimeoutMs },
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
