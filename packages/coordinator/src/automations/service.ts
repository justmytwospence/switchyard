import {
  type Automation,
  AutomationInput,
  type AutomationPreview,
  newId,
  type Occurrence,
  type OccurrenceState,
  SwitchyardError,
  type Task,
} from "@switchyard/protocol";
import { newToken, safeEqualHex, sha256 } from "../auth.js";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { getService } from "../services.js";
import { putTaskState, shortError, taskDoneAt } from "../tasks/common.js";
import { createTask } from "../tasks/service.js";
import { isLiveRun } from "../tasks/state.js";
import {
  dateTimeIn,
  describeTrigger,
  nextOccurrences,
  validateTrigger,
  zoneOf,
} from "./describe.js";

/** Payload substitutions are capped at this many characters in total. */
export const PAYLOAD_RENDER_CAP = 24_000;

export interface TemplateVars {
  date: string;
  time: string;
  occurrence: string;
  payload: unknown;
}

export interface Rendered {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  priority: Task["priority"];
  groupingKey: string | null;
}

export interface FireInput {
  key: string;
  scheduledFor: string | null;
  payload?: unknown;
  /** Record this state without firing (skipped_missed, filtered). */
  record?: { state: OccurrenceState; reason: string };
}

export interface FireResult {
  occurrence: Occurrence;
  task: Task | null;
  duplicate: boolean;
}

const OCC_VARS = "occurrenceVars:";
const TERMINAL = ["done", "canceled"];

/** An automation's task still counts as its tracked (overlapping) work until Done or Canceled. */
function isTracked(task: Pick<Task, "state">): boolean {
  return !TERMINAL.includes(task.state);
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Do the payload's dot-path values equal every filter's `equals` (string comparison)? */
export function filtersMatch(
  filters: Automation["filters"],
  payload: unknown,
): { ok: true } | { ok: false; reason: string } {
  for (const f of filters) {
    const v = getPath(payload, f.path);
    const s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    if (s !== f.equals) {
      return {
        ok: false,
        reason: `Filter ${f.path} = "${f.equals}" did not match "${s.slice(0, 200)}"`,
      };
    }
  }
  return { ok: true };
}

/**
 * Plain `{{name}}` substitution: `date`, `time`, `occurrence`, `payload.<dot.path>`. Payload
 * values are JSON-stringified when not strings; the payload text across one render is capped.
 */
export function makeRenderer(vars: TemplateVars): (template: string) => string {
  let budget = PAYLOAD_RENDER_CAP;
  return (template) =>
    template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) => {
      if (name === "date") return vars.date;
      if (name === "time") return vars.time;
      if (name === "occurrence") return vars.occurrence;
      if (name === "payload" || name.startsWith("payload.")) {
        const v = name === "payload" ? vars.payload : getPath(vars.payload, name.slice(8));
        let s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
        if (s.length > budget) s = s.slice(0, Math.max(0, budget));
        budget -= s.length;
        return s;
      }
      return whole;
    });
}

export function renderTemplate(a: Automation, vars: TemplateVars): Rendered {
  const r = makeRenderer(vars);
  const title = r(a.template.title).trim().slice(0, 300) || a.name;
  return {
    title,
    objective: r(a.template.objective),
    acceptanceCriteria: a.template.acceptanceCriteria.map(r),
    priority: a.template.priority,
    groupingKey: a.groupingKey === null ? null : r(a.groupingKey).trim() || null,
  };
}

/**
 * Automations: CRUD, firing occurrences into tasks (overlap and mode policies), dependency
 * triggers, queued occurrences, history and outcomes. Occurrence keys are unique per automation,
 * so a repeated key never fires twice.
 */
export class AutomationService {
  private unsubscribe: (() => void)[] = [];

  constructor(private readonly ctx: CoordinatorContext) {}

  start(): void {
    const fn = ({ task }: { task: Task | null }) => {
      if (task) this.onTaskChanged(task);
    };
    this.ctx.hub.on("task.changed", fn);
    this.unsubscribe.push(() => this.ctx.hub.off("task.changed", fn));
  }

  stop(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  // ---- CRUD ------------------------------------------------------------------------------

  private validate(input: AutomationInput): void {
    const { store } = this.ctx;
    store.projects.require(input.projectId);
    if (input.hostId) store.hosts.require(input.hostId);
    if (input.profileId) store.profiles.require(input.profileId);
    if (input.trigger.kind === "dependency") store.tasks.require(input.trigger.taskId);
    validateTrigger(input.trigger);
  }

  private nextAt(a: Pick<Automation, "trigger" | "enabled">, after: Date): string | null {
    if (!a.enabled) return null;
    return nextOccurrences(a.trigger, after, 1)[0] ?? null;
  }

  create(raw: unknown): Automation {
    const input = parse(AutomationInput, raw);
    this.validate(input);
    const { store } = this.ctx;
    const now = store.now();
    const iso = now.toISOString();
    const a: Automation = {
      id: newId("aut"),
      ...input,
      nextAt: this.nextAt(input, now),
      lastEvaluatedAt: iso,
      lastOutcome: null,
      failureCount: 0,
      webhookTokenSet: false,
      createdAt: iso,
      updatedAt: iso,
    };
    return store.putAutomation(a);
  }

  update(id: string, patch: Record<string, unknown>): Automation {
    const { store } = this.ctx;
    return store.tx(() => {
      const cur = store.automations.require(id);
      const {
        id: _i,
        nextAt: _n,
        lastEvaluatedAt: _l,
        lastOutcome: _o,
        failureCount: _f,
        webhookTokenSet: _w,
        createdAt: _c,
        updatedAt: _u,
        ...base
      } = cur;
      const input = parse(AutomationInput, { ...base, ...patch });
      this.validate(input);
      const now = store.now();
      const restart =
        JSON.stringify(input.trigger) !== JSON.stringify(cur.trigger) ||
        (input.enabled && !cur.enabled);
      const next: Automation = {
        ...cur,
        ...input,
        lastEvaluatedAt: restart ? now.toISOString() : cur.lastEvaluatedAt,
        nextAt: this.nextAt(input, now),
        updatedAt: now.toISOString(),
      };
      return store.putAutomation(next);
    });
  }

  delete(id: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      const a = store.automations.require(id);
      store.automations.delete(id);
      store.st.get("DELETE FROM occurrences WHERE automation_id = ?").run(id);
      store.appendEvent("automation.deleted", { projectId: a.projectId }, { id });
    });
  }

  /** New webhook token: returned once, only its sha256 is stored. */
  rotateWebhookToken(id: string): { token: string; url: string } {
    const { store, config } = this.ctx;
    const token = newToken();
    store.tx(() => {
      const a = store.automations.require(id);
      store.putAutomation(
        { ...a, webhookTokenSet: true, updatedAt: store.nowIso() },
        { webhook_token_hash: sha256(token) },
      );
    });
    return { token, url: `${config.publicUrl}/api/hooks/${id}` };
  }

  /** Constant-time comparison of the bearer token's sha256 with the stored hash. */
  verifyWebhookToken(id: string, token: string | null): boolean {
    const row = this.ctx.store.st
      .get("SELECT webhook_token_hash FROM automations WHERE id = ?")
      .get(id) as { webhook_token_hash: string | null } | undefined;
    const expected = row?.webhook_token_hash ?? sha256(`absent:${id}`);
    const ok = safeEqualHex(expected, sha256(token ?? ""));
    return ok && !!row?.webhook_token_hash && !!token;
  }

  describe(a: Automation): string {
    return describeTrigger(a.trigger, (id) => this.ctx.store.tasks.get(id)?.title);
  }

  preview(a: Automation): AutomationPreview {
    const now = this.ctx.store.now();
    const { date, time } = dateTimeIn(now, zoneOf(a));
    const r = renderTemplate(a, { date, time, occurrence: "preview", payload: {} });
    return {
      summary: this.describe(a),
      task: {
        title: r.title,
        objective: r.objective,
        acceptanceCriteria: r.acceptanceCriteria,
        priority: r.priority,
      },
      next: a.enabled ? nextOccurrences(a.trigger, now, 5) : [],
    };
  }

  history(id: string, limit = 100): Occurrence[] {
    this.ctx.store.automations.require(id);
    return this.ctx.store.occurrences
      .list("automation_id = ?", [id], "created_at DESC, rowid DESC")
      .slice(0, limit);
  }

  occurrenceByKey(automationId: string, key: string): Occurrence | undefined {
    const row = this.ctx.store.st
      .get("SELECT json FROM occurrences WHERE automation_id = ? AND key = ?")
      .get(automationId, key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Occurrence) : undefined;
  }

  // ---- firing ----------------------------------------------------------------------------

  /**
   * Fire (or record) one occurrence. Insert-or-ignore on `(automationId, key)`: a key that
   * already exists returns the existing occurrence with `duplicate: true` and does nothing.
   * Joins the caller's transaction; host sends run after commit.
   */
  fire(automationId: string, input: FireInput): FireResult {
    const { store } = this.ctx;
    const result = store.tx((): FireResult => {
      const existing = this.occurrenceByKey(automationId, input.key);
      if (existing) {
        return {
          occurrence: existing,
          task: existing.taskId ? (store.tasks.get(existing.taskId) ?? null) : null,
          duplicate: true,
        };
      }
      const a = store.automations.require(automationId);
      const now = store.now();
      const occ: Occurrence = {
        id: newId("occ"),
        automationId,
        key: input.key,
        scheduledFor: input.scheduledFor,
        state: "fired",
        taskId: null,
        reason: null,
        outcome: null,
        createdAt: now.toISOString(),
      };
      if (input.record) {
        occ.state = input.record.state;
        occ.reason = input.record.reason;
      } else {
        const at = input.scheduledFor ? new Date(input.scheduledFor) : now;
        const { date, time } = dateTimeIn(at, zoneOf(a));
        const vars: TemplateVars = {
          date,
          time,
          occurrence: input.scheduledFor ?? input.key,
          payload: input.payload ?? {},
        };
        const r = this.execute(a, occ.id, vars);
        occ.state = r.state;
        occ.taskId = r.taskId;
        occ.reason = r.reason;
      }
      if (!store.insertOccurrence(occ)) {
        throw new SwitchyardError("conflict", "Occurrence already recorded");
      }
      if (occ.state !== "filtered") {
        const label = occurrenceLabel(occ);
        const latest = store.automations.require(automationId);
        if (latest.lastOutcome !== label) {
          store.putAutomation({ ...latest, lastOutcome: label, updatedAt: store.nowIso() });
        }
      }
      return {
        occurrence: occ,
        task: occ.taskId ? (store.tasks.get(occ.taskId) ?? null) : null,
        duplicate: false,
      };
    });
    if (!result.duplicate) getService(this.ctx, "dispatcher")?.schedule();
    return result;
  }

  /** Overlap and mode policy for one occurrence. */
  private execute(
    a: Automation,
    occurrenceId: string,
    vars: TemplateVars,
  ): { state: OccurrenceState; taskId: string | null; reason: string | null } {
    const { store } = this.ctx;
    const r = renderTemplate(a, vars);
    const tracked = this.trackedTasks(a, r.groupingKey);
    if (tracked.length > 0) {
      const t = tracked[0]!;
      const what = `"${t.title}" is still ${t.state.replace("_", " ")}`;
      if (a.overlap === "skip") return { state: "skipped_overlap", taskId: t.id, reason: what };
      if (a.overlap === "queue_one") {
        const queued = store.occurrences.count("automation_id = ? AND state = 'queued'", [a.id]);
        if (queued > 0) {
          return {
            state: "skipped_overlap",
            taskId: t.id,
            reason: `${what} and one occurrence is already queued`,
          };
        }
        store.setSetting(OCC_VARS + occurrenceId, vars);
        return { state: "queued", taskId: null, reason: `Queued until "${t.title}" finishes` };
      }
      this.append(t, r, vars, occurrenceId);
      return { state: "appended", taskId: t.id, reason: null };
    }
    if (a.mode === "continue" && r.groupingKey) {
      const prior = store.tasks.list(
        "automation_id = ? AND grouping_key = ? AND state != 'canceled'",
        [a.id, r.groupingKey],
        "created_at DESC",
      )[0];
      if (prior) {
        this.continueTask(a, prior, r, occurrenceId);
        return { state: "fired", taskId: prior.id, reason: null };
      }
    }
    const task = this.createTask(a, r, occurrenceId);
    return { state: "fired", taskId: task.id, reason: null };
  }

  /** Non-terminal tasks of this automation with the same rendered grouping key. */
  private trackedTasks(a: Automation, groupingKey: string | null): Task[] {
    const list = this.ctx.store.tasks
      .list(
        `automation_id = ? AND state NOT IN (${TERMINAL.map(() => "?").join(", ")})`,
        [a.id, ...TERMINAL],
        "created_at",
      )
      .filter(isTracked);
    return groupingKey === null ? list : list.filter((t) => t.groupingKey === groupingKey);
  }

  private createTask(a: Automation, r: Rendered, occurrenceId: string): Task {
    return createTask(
      this.ctx,
      {
        projectId: a.projectId,
        title: r.title,
        objective: r.objective,
        acceptanceCriteria: r.acceptanceCriteria,
        priority: r.priority,
        state: "ready",
        policy: {
          hostId: a.hostId,
          profileId: a.profileId,
          workspace: { mode: "new_worktree", branch: null, base: null },
          continuation: a.continuation,
          completion: a.completion,
        },
        groupingKey: r.groupingKey,
      },
      {
        kind: "automation",
        automationId: a.id,
        occurrenceId,
        routine: a.trigger.kind === "cron" || a.trigger.kind === "once",
      },
    );
  }

  /** Continue mode: the grouped task becomes Ready again on its existing session/workspace. */
  private continueTask(a: Automation, prior: Task, r: Rendered, occurrenceId: string): Task {
    const { store } = this.ctx;
    const session = prior.sessionId ? store.sessions.get(prior.sessionId) : undefined;
    const workspaceId = session?.workspaceId ?? null;
    return putTaskState(this.ctx, prior, "ready", {
      objective: r.objective,
      acceptanceCriteria: r.acceptanceCriteria,
      blocked: null,
      hiddenFromBoard: false,
      review: { feedback: [], changesRequested: false },
      origin: {
        kind: "automation",
        automationId: a.id,
        occurrenceId,
        routine: a.trigger.kind === "cron" || a.trigger.kind === "once",
      },
      policy: {
        ...prior.policy,
        continuation: a.continuation,
        completion: a.completion,
        workspace: workspaceId ? { mode: "existing", workspaceId } : prior.policy.workspace,
      },
    });
  }

  /** Append: follow-up prompt to a live automated session, else extend the objective. */
  private append(task: Task, r: Rendered, vars: TemplateVars, occurrenceId: string): void {
    const { store, hostHub } = this.ctx;
    const session = task.sessionId ? store.sessions.get(task.sessionId) : undefined;
    const run = task.currentRunId ? store.runs.get(task.currentRunId) : undefined;
    const live =
      !!session &&
      ["idle", "running", "waiting_input"].includes(session.runtime) &&
      !!run &&
      isLiveRun(run) &&
      run.controlMode === "automation";
    if (live && session && run) {
      const cmd = {
        type: "session.prompt" as const,
        sessionId: session.id,
        text: r.objective,
        images: [],
        mode: "followUp" as const,
        origin: "automation" as const,
        controlRevision: run.controlRevision,
      };
      store.afterCommit(() => {
        hostHub.request(session.hostId, cmd, { commandId: `app_${occurrenceId}` }).catch((err) => {
          const e = shortError(err);
          this.ctx.log.warn({ err, taskId: task.id }, "append follow-up failed");
          this.markAppendFailed(occurrenceId, `Follow-up could not be sent: ${e.message}`);
        });
      });
      store.putTask({ ...task, lastActivityAt: store.nowIso(), updatedAt: store.nowIso() });
      return;
    }
    const objective = `${task.objective}\n\n## Update ${vars.date} ${vars.time}\n\n${r.objective}`;
    if (isLiveRun(run)) {
      store.putTask({ ...task, objective, updatedAt: store.nowIso() });
      return;
    }
    putTaskState(this.ctx, task, "ready", { objective, blocked: null });
  }

  /** The appended follow-up never reached Pi: the occurrence failed (counted like a failed fire). */
  private markAppendFailed(occurrenceId: string, reason: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      const occ = store.occurrences.get(occurrenceId);
      if (occ?.state !== "appended") return;
      const task = occ.taskId ? store.tasks.get(occ.taskId) : undefined;
      const next = store.putOccurrence(
        { ...occ, state: "failed", reason: reason.slice(0, 500) },
        task?.projectId,
      );
      const a = store.automations.get(occ.automationId);
      if (a) {
        store.putAutomation({
          ...a,
          lastOutcome: occurrenceLabel(next),
          failureCount: a.failureCount + 1,
          updatedAt: store.nowIso(),
        });
      }
    });
  }

  // ---- reactions -------------------------------------------------------------------------

  /** Dependency triggers and queued occurrences react to task changes. */
  onTaskChanged(task: Task): void {
    const { store } = this.ctx;
    if (task.state === "done") {
      const doneAt = taskDoneAt(this.ctx, task.id) ?? task.updatedAt;
      for (const a of store.automations.list("enabled = 1")) {
        if (a.trigger.kind !== "dependency" || a.trigger.taskId !== task.id) continue;
        try {
          this.fire(a.id, {
            key: `dep:${task.id}:${doneAt}`,
            scheduledFor: null,
            payload: { task },
          });
        } catch (err) {
          this.ctx.log.warn({ err, automationId: a.id }, "dependency trigger failed");
        }
      }
    }
    if (task.origin.kind === "automation" && !isTracked(task)) {
      this.releaseQueued(task.origin.automationId);
    }
  }

  /** Fire the queued occurrence once none of its tracked work is left (all Done or Canceled). */
  private releaseQueued(automationId: string): void {
    const { store } = this.ctx;
    const a = store.automations.get(automationId);
    if (!a) return;
    const occ = store.occurrences.list(
      "automation_id = ? AND state = 'queued'",
      [automationId],
      "created_at",
    )[0];
    if (!occ) return;
    const vars = store.getSetting<TemplateVars | null>(OCC_VARS + occ.id, null);
    if (!vars) return;
    const r = renderTemplate(a, vars);
    if (this.trackedTasks(a, r.groupingKey).length > 0) return;
    store.tx(() => {
      const cur = store.occurrences.get(occ.id);
      if (cur?.state !== "queued") return;
      // Overlap no longer applies: the tracked work finished (or left the queue).
      const fired = this.executeWithoutOverlap(a, occ.id, vars);
      const next: Occurrence = { ...cur, state: "fired", taskId: fired.id, reason: null };
      store.putOccurrence(next, a.projectId);
      store.st.get("DELETE FROM settings WHERE key = ?").run(OCC_VARS + occ.id);
    });
    getService(this.ctx, "dispatcher")?.schedule();
  }

  private executeWithoutOverlap(a: Automation, occurrenceId: string, vars: TemplateVars): Task {
    const r = renderTemplate(a, vars);
    if (a.mode === "continue" && r.groupingKey) {
      const prior = this.ctx.store.tasks.list(
        "automation_id = ? AND grouping_key = ? AND state NOT IN ('canceled', 'ready', 'in_progress')",
        [a.id, r.groupingKey],
        "created_at DESC",
      )[0];
      if (prior && TERMINAL.includes(prior.state)) {
        return this.continueTask(a, prior, r, occurrenceId);
      }
    }
    return this.createTask(a, r, occurrenceId);
  }

  /**
   * A task from this automation finished: update the occurrence outcome, `lastOutcome` and the
   * consecutive `failureCount` (reset on success).
   */
  recordOutcome(task: Task, outcome: string, failed: boolean): void {
    if (task.origin.kind !== "automation") return;
    const { store } = this.ctx;
    const { automationId, occurrenceId } = task.origin;
    store.tx(() => {
      const occ = store.occurrences.get(occurrenceId);
      if (occ && occ.outcome !== outcome) store.putOccurrence({ ...occ, outcome }, task.projectId);
      const a = store.automations.get(automationId);
      if (!a) return;
      store.putAutomation({
        ...a,
        lastOutcome: outcome,
        failureCount: failed ? a.failureCount + 1 : 0,
        updatedAt: store.nowIso(),
      });
    });
  }
}

function occurrenceLabel(o: Occurrence): string {
  switch (o.state) {
    case "fired":
      return "Fired";
    case "queued":
      return "Queued behind running work";
    case "appended":
      return "Appended to running work";
    case "skipped_overlap":
      return "Skipped: previous work still running";
    case "skipped_missed":
      return "Skipped: missed while offline";
    case "failed":
      return `Failed${o.reason ? `: ${o.reason}` : ""}`;
    case "filtered":
      return "Filtered";
  }
}
