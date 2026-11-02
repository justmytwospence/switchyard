import type { Automation } from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { cronFor, nextOccurrences } from "./describe.js";
import type { AutomationService } from "./service.js";

/** An occurrence older than this when evaluated counts as missed. */
export const MISSED_AFTER_MS = 120_000;
/** At most this many occurrences are kept per evaluation window. */
export const MAX_ENUMERATED = 1000;

export interface SchedulerOptions {
  /** Tick interval (default 15 s); 0 disables the timer (tests call `tick()`). */
  tickMs: number;
}

/** Scheduled occurrences in `(from, to]`, oldest first, capped to the newest `MAX_ENUMERATED`. */
export function enumerate(a: Pick<Automation, "trigger">, from: Date, to: Date): Date[] {
  const t = a.trigger;
  if (t.kind === "once") {
    const at = new Date(t.at);
    return at > from && at <= to ? [at] : [];
  }
  if (t.kind !== "cron") return [];
  const cron = cronFor(t.expr, t.timezone);
  const out: Date[] = [];
  let prev = from;
  for (let i = 0; i < 500_000; i++) {
    const next = cron.nextRun(prev);
    if (!next || next > to) break;
    out.push(next);
    if (out.length > MAX_ENUMERATED) out.shift();
    prev = next;
  }
  return out;
}

/**
 * Time-based triggers (cron in its timezone, once). Each tick evaluates `(lastEvaluatedAt, now]`:
 * on-time occurrences fire, missed ones follow the missed policy. Firing, occurrence rows and
 * `lastEvaluatedAt` commit together, and occurrence keys are unique, so restarts never
 * double-fire.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly automations: AutomationService,
    private readonly opts: SchedulerOptions = { tickMs: 15_000 },
  ) {}

  start(): void {
    if (this.opts.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.opts.tickMs);
      this.timer.unref();
    }
    this.immediate = setImmediate(() => this.tick());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.ctx.store.now();
    for (const a of this.ctx.store.automations.list("enabled = 1")) {
      if (a.trigger.kind !== "cron" && a.trigger.kind !== "once") continue;
      try {
        this.evaluate(a.id, now);
      } catch (err) {
        this.ctx.log.error({ err, automationId: a.id }, "automation evaluation failed");
      }
    }
  }

  /** Fire one occurrence; a failure is recorded as a `failed` occurrence instead of retried. */
  private fireSafely(automationId: string, at: Date): void {
    const { store } = this.ctx;
    const iso = at.toISOString();
    const r = store.savepoint(() =>
      this.automations.fire(automationId, { key: iso, scheduledFor: iso }),
    );
    if (r.ok) return;
    const message = r.error instanceof Error ? r.error.message : String(r.error);
    this.ctx.log.warn({ err: r.error, automationId }, "automation occurrence failed");
    this.automations.fire(automationId, {
      key: iso,
      scheduledFor: iso,
      record: { state: "failed", reason: message.slice(0, 500) },
    });
    const a = store.automations.require(automationId);
    store.putAutomation({ ...a, failureCount: a.failureCount + 1, updatedAt: store.nowIso() });
  }

  /** Evaluate one automation's window up to `now`. */
  evaluate(automationId: string, now: Date): void {
    const { store } = this.ctx;
    store.tx(() => {
      const a = store.automations.get(automationId);
      if (!a?.enabled) return;
      const from = new Date(a.lastEvaluatedAt ?? a.createdAt);
      if (now <= from) return;
      const due = enumerate(a, from, now);
      const missed = due.filter((d) => now.getTime() - d.getTime() > MISSED_AFTER_MS);
      const onTime = due.filter((d) => now.getTime() - d.getTime() <= MISSED_AFTER_MS);
      if (missed.length > 0) {
        const newest = missed[missed.length - 1]!;
        if (a.missed === "run_once") {
          if (missed.length > 1) {
            const older = missed[missed.length - 2]!;
            this.automations.fire(a.id, {
              key: older.toISOString(),
              scheduledFor: older.toISOString(),
              record: {
                state: "skipped_missed",
                reason: `${missed.length - 1} earlier occurrence${missed.length === 2 ? "" : "s"} missed while offline`,
              },
            });
          }
          this.fireSafely(a.id, newest);
        } else {
          this.automations.fire(a.id, {
            key: newest.toISOString(),
            scheduledFor: newest.toISOString(),
            record: {
              state: "skipped_missed",
              reason: `Missed ${missed.length} occurrence${missed.length === 1 ? "" : "s"} while offline`,
            },
          });
        }
      }
      for (const d of onTime) this.fireSafely(a.id, d);
      const latest = store.automations.require(a.id);
      const nextAt = nextOccurrences(latest.trigger, now, 1)[0] ?? null;
      const next: Automation = { ...latest, lastEvaluatedAt: now.toISOString(), nextAt };
      if (nextAt !== latest.nextAt) store.putAutomation({ ...next, updatedAt: store.nowIso() });
      // lastEvaluatedAt alone changes every tick: write it without an event.
      else store.automations.upsert(next);
    });
  }
}
