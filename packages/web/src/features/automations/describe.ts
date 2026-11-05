import {
  type Automation,
  AutomationInput,
  type Occurrence,
  PRIORITY_LABELS,
  type Priority,
  type Trigger,
} from "@switchyard/protocol";

/*
 * Pure helpers for the Automations feature: a small cron describer, trigger
 * and whole-automation summaries, the editor draft <-> AutomationInput
 * conversion with field-level validation, and history merging.
 */

/* ------------------------------------------------------------------ */
/* Labels and explanations                                             */
/* ------------------------------------------------------------------ */

export type AutomationMode = AutomationInput["mode"];
export type OverlapPolicy = AutomationInput["overlap"];
export type MissedPolicy = AutomationInput["missed"];
export type TriggerKind = Trigger["kind"];

export const TRIGGER_KIND_LABELS: Record<TriggerKind, string> = {
  manual: "Manual",
  once: "Once",
  cron: "Schedule",
  webhook: "Webhook",
  dependency: "Dependency",
};

export const MODE_OPTIONS: { value: AutomationMode; label: string; explanation: string }[] = [
  { value: "fresh", label: "Fresh", explanation: "Fresh: a new task per occurrence" },
  {
    value: "continue",
    label: "Continue",
    explanation: "Continue: reuse the task with the same grouping key",
  },
  {
    value: "watch",
    label: "Watch",
    explanation: "Watch: only raises attention when something relevant changed",
  },
];

export const OVERLAP_OPTIONS: { value: OverlapPolicy; label: string; explanation: string }[] = [
  {
    value: "skip",
    label: "Skip",
    explanation: "Skip: drop the occurrence while earlier work is still open",
  },
  {
    value: "queue_one",
    label: "Queue one",
    explanation: "Queue one: keep a single pending occurrence and fire it when the open work ends",
  },
  {
    value: "append",
    label: "Append",
    explanation: "Append: add the new objective to the open task (as a follow-up if it is running)",
  },
];

export const MISSED_OPTIONS: { value: MissedPolicy; label: string; explanation: string }[] = [
  {
    value: "skip",
    label: "Skip",
    explanation: "Skip: occurrences missed while the coordinator was down are recorded and skipped",
  },
  {
    value: "run_once",
    label: "Run once",
    explanation: "Run once: on return, fire the newest missed occurrence once",
  },
];

export function modeLabel(mode: AutomationMode): string {
  return MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode;
}

export function priorityLabel(p: Priority): string {
  return PRIORITY_LABELS[p] ?? String(p);
}

export const TEMPLATE_VARIABLES = ["{{date}}", "{{time}}", "{{occurrence}}", "{{payload.<path>}}"];

/* ------------------------------------------------------------------ */
/* Text utilities                                                      */
/* ------------------------------------------------------------------ */

/** "a", "a and b", "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  /** Three-letter aliases mapped to `min + index`. */
  names?: string[];
}

const CRON_FIELDS: FieldDef[] = [
  { name: "Minute", min: 0, max: 59 },
  { name: "Hour", min: 0, max: 23 },
  { name: "Day of month", min: 1, max: 31 },
  {
    name: "Month",
    min: 1,
    max: 12,
    names: MONTH_NAMES.map((m) => m.slice(0, 3).toLowerCase()),
  },
  {
    name: "Day of week",
    min: 0,
    max: 7,
    names: DAY_NAMES.map((d) => d.slice(0, 3).toLowerCase()),
  },
];

export interface CronField {
  /** `*` (or `?`): every value. */
  any: boolean;
  /** Expanded, sorted, unique values (empty when `any`). */
  values: number[];
  /** Set when the field is a single `*\/n` or `a/n` step. */
  step: { every: number; start: number } | null;
  /** Uses croner extensions (L, W, #) the describer does not explain. */
  extended: boolean;
}

function parseValue(token: string, def: FieldDef): number | string {
  const lower = token.toLowerCase();
  if (def.names) {
    const idx = def.names.indexOf(lower);
    if (idx >= 0) return def.min + idx;
  }
  if (!/^\d+$/.test(token)) return `"${token}" is not a number`;
  const n = Number(token);
  if (n < def.min || n > def.max) return `${n} is out of range ${def.min}–${def.max}`;
  return n;
}

/** Parse one cron field; returns an error message for invalid input. */
export function parseCronField(src: string, def: FieldDef): CronField | string {
  if (src === "*" || src === "?") return { any: true, values: [], step: null, extended: false };
  if (/[LW#]/i.test(src) && !def.names?.some((n) => src.toLowerCase().includes(n))) {
    if (!/^[0-9A-Za-z*?,\-/#]+$/.test(src)) return `"${src}" is not valid`;
    return { any: false, values: [], step: null, extended: true };
  }
  const parts = src.split(",");
  const values = new Set<number>();
  let step: CronField["step"] = null;
  for (const part of parts) {
    if (!part) return "empty list item";
    const [base, stepStr, extra] = part.split("/");
    if (extra !== undefined) return `"${part}" has more than one step`;
    let every = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr) || Number(stepStr) < 1) return `"${stepStr}" is not a valid step`;
      every = Number(stepStr);
    }
    let start: number;
    let end: number;
    if (base === "*" || base === "?") {
      start = def.min;
      end = def.max;
    } else if (base?.includes("-")) {
      const [a, b] = base.split("-");
      const av = parseValue(a ?? "", def);
      const bv = parseValue(b ?? "", def);
      if (typeof av === "string") return av;
      if (typeof bv === "string") return bv;
      if (av > bv) return `range ${base} runs backwards`;
      start = av;
      end = bv;
    } else {
      const v = parseValue(base ?? "", def);
      if (typeof v === "string") return v;
      start = v;
      end = stepStr !== undefined ? def.max : v;
    }
    for (let i = start; i <= end; i += every) values.add(i);
    if (parts.length === 1 && stepStr !== undefined && !base?.includes("-")) {
      step = { every, start };
    }
  }
  let sorted = [...values].sort((a, b) => a - b);
  // Day of week: 7 is Sunday.
  if (def.max === 7) sorted = [...new Set(sorted.map((v) => v % 7))].sort((a, b) => a - b);
  const full = def.max === 7 ? 7 : def.max - def.min + 1;
  if (sorted.length === full && !step)
    return { any: true, values: [], step: null, extended: false };
  return { any: false, values: sorted, step, extended: false };
}

export function parseCron(expr: string): CronField[] | string {
  const trimmed = expr.trim();
  if (!trimmed) return "Enter a cron expression";
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }
  const out: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const def = CRON_FIELDS[i]!;
    const parsed = parseCronField(fields[i]!, def);
    if (typeof parsed === "string") return `${def.name}: ${parsed}`;
    out.push(parsed);
  }
  return out;
}

/** Null when valid, otherwise a message. */
export function validateCron(expr: string): string | null {
  const parsed = parseCron(expr);
  return typeof parsed === "string" ? parsed : null;
}

/** Null when the IANA timezone is known to this browser. */
export function validateTimezone(tz: string): string | null {
  if (!tz.trim()) return "Enter a timezone";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return null;
  } catch {
    return `Unknown timezone "${tz}"`;
  }
}

function isContiguous(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]! + 1) return false;
  return values.length > 0;
}

type TimePhrase = { kind: "at"; text: string } | { kind: "freq"; text: string };

function describeTime(m: CronField, h: CronField): TimePhrase | null {
  if (m.any && h.any) return { kind: "freq", text: "Every minute" };
  if (m.step && m.step.start === 0 && h.any) {
    return {
      kind: "freq",
      text: m.step.every === 1 ? "Every minute" : `Every ${m.step.every} minutes`,
    };
  }
  if (m.any) {
    if (h.step || h.values.length === 0) return null;
    if (isContiguous(h.values)) {
      return {
        kind: "freq",
        text: `Every minute from ${pad(h.values[0]!)}:00 to ${pad(h.values[h.values.length - 1]!)}:59`,
      };
    }
    return null;
  }
  if (h.any) {
    if (m.step) return null;
    if (m.values.length === 1 && m.values[0] === 0) return { kind: "freq", text: "Every hour" };
    return {
      kind: "freq",
      text: `Every hour at ${listText(m.values.map((v) => `:${pad(v)}`))}`,
    };
  }
  if (h.step && h.step.start === 0 && m.values.length === 1 && !m.step) {
    const at = m.values[0] === 0 ? "" : ` at :${pad(m.values[0]!)}`;
    return {
      kind: "freq",
      text: h.step.every === 1 ? `Every hour${at}` : `Every ${h.step.every} hours${at}`,
    };
  }
  if (m.values.length * h.values.length <= 6) {
    const times: string[] = [];
    for (const hv of h.values) for (const mv of m.values) times.push(`${pad(hv)}:${pad(mv)}`);
    return { kind: "at", text: listText(times) };
  }
  if (!isContiguous(h.values)) return null;
  const first = h.values[0]!;
  const last = h.values[h.values.length - 1]!;
  if (m.step && m.step.start === 0) {
    return {
      kind: "freq",
      text: `Every ${m.step.every} minutes from ${pad(first)}:00 to ${pad(last)}:59`,
    };
  }
  if (m.values.length === 1) {
    const mm = pad(m.values[0]!);
    return { kind: "freq", text: `Every hour from ${pad(first)}:${mm} to ${pad(last)}:${mm}` };
  }
  return null;
}

/** Monday-first ordering for day-of-week lists. */
function mondayFirst(a: number, b: number): number {
  return ((a + 6) % 7) - ((b + 6) % 7);
}

function describeDays(
  dom: CronField,
  mon: CronField,
  dow: CronField,
): { lead: string; qual: string } | null {
  if (!dom.any && !dow.any) return null;
  const months = mon.any ? null : listText(mon.values.map((v) => MONTH_NAMES[v - 1]!));
  const inMonths = months ? ` in ${months}` : "";
  if (!dow.any) {
    const days = [...dow.values].sort(mondayFirst);
    const key = days.join(",");
    if (key === "1,2,3,4,5") {
      return { lead: `Every weekday${inMonths}`, qual: ` on weekdays${inMonths}` };
    }
    if (key === "6,0") {
      return { lead: `Every Saturday and Sunday${inMonths}`, qual: ` on weekends${inMonths}` };
    }
    const names = days.map((d) => DAY_NAMES[d]!);
    return {
      lead: `Every ${listText(names)}${inMonths}`,
      qual: ` on ${listText(names.map((n) => `${n}s`))}${inMonths}`,
    };
  }
  if (!dom.any) {
    if (dom.values.length > 5) return null;
    const ords = listText(dom.values.map(ordinal));
    const of = months ? months : "every month";
    return { lead: `On the ${ords} of ${of}`, qual: ` on the ${ords} of ${of}` };
  }
  return { lead: `Every day${inMonths}`, qual: inMonths };
}

/**
 * Human description of a 5-field cron expression ("Every weekday at 09:00
 * (America/Denver)"), or null when the expression is outside what this small
 * describer covers.
 */
export function describeCron(expr: string, timezone?: string): string | null {
  const parsed = parseCron(expr);
  if (typeof parsed === "string") return null;
  if (parsed.some((f) => f.extended)) return null;
  const [m, h, dom, mon, dow] = parsed as [CronField, CronField, CronField, CronField, CronField];
  const time = describeTime(m, h);
  const days = describeDays(dom, mon, dow);
  if (!time || !days) return null;
  const text = time.kind === "at" ? `${days.lead} at ${time.text}` : `${time.text}${days.qual}`;
  return timezone ? `${text} (${timezone})` : text;
}

/** describeCron with the raw-expression fallback. */
export function describeCronOrRaw(expr: string, timezone: string): string {
  return describeCron(expr, timezone) ?? `Cron ${expr.trim()} (${timezone})`;
}

/* ------------------------------------------------------------------ */
/* Summaries                                                           */
/* ------------------------------------------------------------------ */

export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface SummaryContext {
  projectName?: string | null;
  /** Name of the explicitly selected host; null/undefined means the project default. */
  hostName?: string | null;
  profileName?: string | null;
  taskTitle?: (taskId: string) => string | undefined;
  formatDate?: (iso: string) => string;
}

/** Short trigger summary for list rows. */
export function describeTrigger(trigger: Trigger, ctx: SummaryContext = {}): string {
  const fmt = ctx.formatDate ?? formatAbsolute;
  switch (trigger.kind) {
    case "manual":
      return "Manual";
    case "once":
      return trigger.at && !Number.isNaN(Date.parse(trigger.at))
        ? `Once at ${fmt(trigger.at)}`
        : "Once (no time chosen)";
    case "cron":
      return describeCronOrRaw(trigger.expr, trigger.timezone);
    case "webhook":
      return "Webhook";
    case "dependency": {
      const title = trigger.taskId ? ctx.taskTitle?.(trigger.taskId) : undefined;
      if (title) return `When "${title}" is done`;
      return trigger.taskId ? "When a deleted task is done" : "When a task is done";
    }
  }
}

type SummaryInput = Pick<
  AutomationInput,
  | "trigger"
  | "filters"
  | "template"
  | "mode"
  | "groupingKey"
  | "overlap"
  | "missed"
  | "continuation"
  | "completion"
>;

function triggerClause(input: SummaryInput, ctx: SummaryContext): string {
  const t = input.trigger;
  switch (t.kind) {
    case "manual":
      return "When run manually";
    case "webhook": {
      const filters = input.filters.filter((f) => f.path.trim());
      if (filters.length === 0) return "When a webhook is received";
      return `When a webhook is received where ${listText(
        filters.map((f) => `${f.path.trim()} = "${f.equals}"`),
      )}`;
    }
    default:
      return describeTrigger(t, ctx);
  }
}

/**
 * One-paragraph description of what the automation does, e.g. 'Every weekday
 * at 09:00 (America/Denver), create a fresh task "Triage" in Web on my-server; skip
 * if previous work is still open; skip missed runs; requires human review'.
 */
export function summarizeAutomation(input: SummaryInput, ctx: SummaryContext = {}): string {
  const title = input.template.title.trim() || "Untitled task";
  const project = ctx.projectName ? ` in ${ctx.projectName}` : "";
  const host = ctx.hostName ? ` on ${ctx.hostName}` : " on the project's default host";
  const profile = ctx.profileName ? ` with profile ${ctx.profileName}` : "";
  let action: string;
  switch (input.mode) {
    case "continue": {
      const key = input.groupingKey?.trim();
      action = key
        ? `continue the task grouped by "${key}" (or create "${title}")`
        : `continue the matching task (or create "${title}")`;
      break;
    }
    case "watch":
      action = `create a watch task "${title}" that only raises attention when something relevant changed`;
      break;
    default:
      action = `create a fresh task "${title}"`;
  }
  const parts = [`${triggerClause(input, ctx)}, ${action}${project}${host}${profile}`];
  parts.push(
    input.overlap === "skip"
      ? "skip if previous work is still open"
      : input.overlap === "queue_one"
        ? "queue one occurrence if previous work is still open"
        : "append to the open task if previous work is still open",
  );
  if (input.trigger.kind === "cron" || input.trigger.kind === "once") {
    parts.push(input.missed === "skip" ? "skip missed runs" : "run missed runs once on return");
  }
  if (input.continuation.enabled) {
    const c = input.continuation;
    parts.push(
      `continue automatically up to ${c.maxContinuations} times within ${c.maxElapsedMinutes} minutes`,
    );
  }
  const checks = input.completion.checks;
  if (checks && checks.length > 0) {
    parts.push(`run ${checks.length === 1 ? "1 check" : `${checks.length} checks`}`);
  }
  parts.push(
    input.completion.requireHumanReview ? "requires human review" : "no human review required",
  );
  return capitalize(parts.join("; "));
}

/* ------------------------------------------------------------------ */
/* Editor draft                                                        */
/* ------------------------------------------------------------------ */

/** Form state: strings for inputs so partial edits survive validation. */
export interface AutomationDraft {
  name: string;
  enabled: boolean;
  projectId: string;
  triggerKind: TriggerKind;
  /** datetime-local value (local time, no zone). */
  onceAt: string;
  cronExpr: string;
  cronTimezone: string;
  dependencyTaskId: string;
  filters: { path: string; equals: string }[];
  title: string;
  objective: string;
  /** One criterion per line. */
  criteria: string;
  priority: Priority;
  /** "" = project default. */
  hostId: string;
  /** "" = project default. */
  profileId: string;
  mode: AutomationMode;
  groupingKey: string;
  overlap: OverlapPolicy;
  missed: MissedPolicy;
  continuationEnabled: boolean;
  continuationObjective: string;
  maxContinuations: string;
  maxElapsedMinutes: string;
  maxTokens: string;
  maxCostUsd: string;
  /** One check per line; empty = project default (null). */
  checks: string;
  requireHumanReview: boolean;
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyDraft(opts: { projectId?: string; timezone?: string } = {}): AutomationDraft {
  return {
    name: "",
    enabled: true,
    projectId: opts.projectId ?? "",
    triggerKind: "manual",
    onceAt: "",
    cronExpr: "0 9 * * 1-5",
    cronTimezone: opts.timezone ?? localTimezone(),
    dependencyTaskId: "",
    filters: [],
    title: "",
    objective: "",
    criteria: "",
    priority: 2,
    hostId: "",
    profileId: "",
    mode: "fresh",
    groupingKey: "",
    overlap: "skip",
    missed: "skip",
    continuationEnabled: false,
    continuationObjective: "",
    maxContinuations: "5",
    maxElapsedMinutes: "60",
    maxTokens: "",
    maxCostUsd: "",
    checks: "",
    requireHumanReview: true,
  };
}

/** ISO -> datetime-local value in this browser's timezone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value -> ISO (interpreted as local time), or "" when empty/invalid. */
export function localInputToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function draftFromAutomation(
  a: Automation | AutomationInput,
  opts: { timezone?: string } = {},
): AutomationDraft {
  const base = emptyDraft({ projectId: a.projectId, timezone: opts.timezone });
  const t = a.trigger;
  const c = a.continuation;
  return {
    ...base,
    name: a.name,
    enabled: a.enabled,
    triggerKind: t.kind,
    onceAt: t.kind === "once" ? isoToLocalInput(t.at) : "",
    cronExpr: t.kind === "cron" ? t.expr : base.cronExpr,
    cronTimezone: t.kind === "cron" ? t.timezone : base.cronTimezone,
    dependencyTaskId: t.kind === "dependency" ? t.taskId : "",
    filters: a.filters.map((f) => ({ ...f })),
    title: a.template.title,
    objective: a.template.objective,
    criteria: a.template.acceptanceCriteria.join("\n"),
    priority: a.template.priority,
    hostId: a.hostId ?? "",
    profileId: a.profileId ?? "",
    mode: a.mode,
    groupingKey: a.groupingKey ?? "",
    overlap: a.overlap,
    missed: a.missed,
    continuationEnabled: c.enabled,
    continuationObjective: c.enabled ? c.objective : "",
    maxContinuations: c.enabled ? String(c.maxContinuations) : base.maxContinuations,
    maxElapsedMinutes: c.enabled ? String(c.maxElapsedMinutes) : base.maxElapsedMinutes,
    maxTokens: c.enabled && c.maxTokens !== null ? String(c.maxTokens) : "",
    maxCostUsd: c.enabled && c.maxCostUsd !== null ? String(c.maxCostUsd) : "",
    checks: a.completion.checks ? a.completion.checks.join("\n") : "",
    requireHumanReview: a.completion.requireHumanReview,
  };
}

function toNumber(s: string): number {
  return s.trim() === "" ? Number.NaN : Number(s.trim());
}

function toOptionalNumber(s: string): number | null {
  return s.trim() === "" ? null : Number(s.trim());
}

function draftTrigger(d: AutomationDraft): Trigger {
  switch (d.triggerKind) {
    case "manual":
      return { kind: "manual" };
    case "once":
      return { kind: "once", at: localInputToIso(d.onceAt) };
    case "cron":
      return { kind: "cron", expr: d.cronExpr.trim(), timezone: d.cronTimezone.trim() };
    case "webhook":
      return { kind: "webhook" };
    case "dependency":
      return { kind: "dependency", taskId: d.dependencyTaskId };
  }
}

/**
 * Build the request body from a draft. The result is shaped like an
 * AutomationInput but is not validated (numbers may be NaN, strings empty);
 * run validateDraft before sending it.
 */
export function draftToInput(d: AutomationDraft): AutomationInput {
  const checks = lines(d.checks);
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    projectId: d.projectId,
    trigger: draftTrigger(d),
    filters: d.filters
      .filter((f) => f.path.trim() || f.equals.trim())
      .map((f) => ({ path: f.path.trim(), equals: f.equals })),
    template: {
      title: d.title.trim(),
      objective: d.objective,
      acceptanceCriteria: lines(d.criteria),
      priority: d.priority,
    },
    hostId: d.hostId || null,
    profileId: d.profileId || null,
    mode: d.mode,
    groupingKey: d.groupingKey.trim() || null,
    overlap: d.overlap,
    missed: d.missed,
    continuation: d.continuationEnabled
      ? {
          enabled: true,
          objective: d.continuationObjective.trim(),
          maxContinuations: toNumber(d.maxContinuations),
          maxElapsedMinutes: toNumber(d.maxElapsedMinutes),
          maxTokens: toOptionalNumber(d.maxTokens),
          maxCostUsd: toOptionalNumber(d.maxCostUsd),
        }
      : { enabled: false },
    completion: {
      checks: checks.length > 0 ? checks : null,
      requireHumanReview: d.requireHumanReview,
    },
  };
}

/** Draft field keys that can carry an inline error. */
export type DraftField =
  | keyof AutomationDraft
  | `filters.${number}.path`
  | `filters.${number}.equals`
  | "form";

export type DraftErrors = Partial<Record<DraftField, string>>;

const PATH_TO_FIELD: Record<string, DraftField> = {
  name: "name",
  enabled: "enabled",
  projectId: "projectId",
  trigger: "triggerKind",
  "trigger.kind": "triggerKind",
  "trigger.at": "onceAt",
  "trigger.expr": "cronExpr",
  "trigger.timezone": "cronTimezone",
  "trigger.taskId": "dependencyTaskId",
  "template.title": "title",
  "template.objective": "objective",
  "template.acceptanceCriteria": "criteria",
  "template.priority": "priority",
  hostId: "hostId",
  profileId: "profileId",
  mode: "mode",
  groupingKey: "groupingKey",
  overlap: "overlap",
  missed: "missed",
  "continuation.objective": "continuationObjective",
  "continuation.maxContinuations": "maxContinuations",
  "continuation.maxElapsedMinutes": "maxElapsedMinutes",
  "continuation.maxTokens": "maxTokens",
  "continuation.maxCostUsd": "maxCostUsd",
  "completion.checks": "checks",
  "completion.requireHumanReview": "requireHumanReview",
};

/** Map a zod issue path to a draft field. */
export function fieldForPath(path: readonly PropertyKey[]): DraftField {
  const parts = path.map(String);
  if (parts[0] === "filters" && parts.length >= 3) {
    return `filters.${Number(parts[1])}.${parts[2] === "equals" ? "equals" : "path"}`;
  }
  if (parts[0] === "template" && parts[1] === "acceptanceCriteria") return "criteria";
  if (parts[0] === "completion" && parts[1] === "checks") return "checks";
  for (let n = parts.length; n > 0; n--) {
    const f = PATH_TO_FIELD[parts.slice(0, n).join(".")];
    if (f) return f;
  }
  return "form";
}

function intError(s: string, min: number, max: number, label: string): string | null {
  const n = toNumber(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `${label} must be a whole number from ${min} to ${max}`;
  }
  return null;
}

/**
 * Validate a draft: friendly checks first (required fields, cron, timezone,
 * number ranges), then AutomationInput.safeParse for anything else.
 */
export function validateDraft(d: AutomationDraft): {
  input: AutomationInput | null;
  errors: DraftErrors;
} {
  const errors: DraftErrors = {};
  const set = (f: DraftField, msg: string | null) => {
    if (msg && !errors[f]) errors[f] = msg;
  };
  if (!d.name.trim()) set("name", "Name is required");
  if (!d.projectId) set("projectId", "Choose a project");
  if (!d.title.trim()) set("title", "Task title is required");
  switch (d.triggerKind) {
    case "once":
      if (!localInputToIso(d.onceAt)) set("onceAt", "Choose a date and time");
      break;
    case "cron":
      set("cronExpr", validateCron(d.cronExpr));
      set("cronTimezone", validateTimezone(d.cronTimezone));
      break;
    case "dependency":
      if (!d.dependencyTaskId) set("dependencyTaskId", "Choose the task to wait for");
      break;
  }
  d.filters.forEach((f, i) => {
    if (!f.path.trim() && f.equals.trim()) set(`filters.${i}.path`, "Enter a payload path");
  });
  if (d.mode === "continue" && !d.groupingKey.trim()) {
    set("groupingKey", "A grouping key is required to continue an existing task");
  }
  if (d.continuationEnabled) {
    if (!d.continuationObjective.trim()) {
      set("continuationObjective", "An objective is required when continuation is on");
    }
    set("maxContinuations", intError(d.maxContinuations, 1, 50, "Max continuations"));
    set("maxElapsedMinutes", intError(d.maxElapsedMinutes, 1, 1440, "Max elapsed minutes"));
    if (d.maxTokens.trim()) {
      const n = toNumber(d.maxTokens);
      if (!Number.isInteger(n) || n <= 0)
        set("maxTokens", "Max tokens must be a positive whole number");
    }
    if (d.maxCostUsd.trim()) {
      const n = toNumber(d.maxCostUsd);
      if (!Number.isFinite(n) || n <= 0) set("maxCostUsd", "Max cost must be a positive amount");
    }
  }
  const raw = draftToInput(d);
  const parsed = AutomationInput.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) set(fieldForPath(issue.path), issue.message);
  }
  const ok = parsed.success && Object.keys(errors).length === 0;
  return { input: ok ? parsed.data : null, errors };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export function occurrenceTime(o: Occurrence): string {
  return o.scheduledFor ?? o.createdAt;
}

/** Union by id (later lists win), newest first. */
export function mergeOccurrences(...lists: (Occurrence[] | undefined | null)[]): Occurrence[] {
  const byId = new Map<string, Occurrence>();
  for (const list of lists) for (const o of list ?? []) byId.set(o.id, o);
  return [...byId.values()].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || occurrenceTime(b).localeCompare(occurrenceTime(a)),
  );
}

/** Accept `Occurrence[]` or `{items|occurrences: Occurrence[]}`. */
export function normalizeHistory(res: unknown): Occurrence[] {
  if (Array.isArray(res)) return res as Occurrence[];
  if (res && typeof res === "object") {
    const r = res as { items?: unknown; occurrences?: unknown };
    if (Array.isArray(r.items)) return r.items as Occurrence[];
    if (Array.isArray(r.occurrences)) return r.occurrences as Occurrence[];
  }
  return [];
}

export function curlExample(token: string, url: string): string {
  return `curl -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '{}' ${url}`;
}
