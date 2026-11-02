import type { Automation, Trigger } from "@switchyard/protocol";
import { SwitchyardError } from "@switchyard/protocol";
import { Cron } from "croner";

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

/** A paused croner job for enumeration only (5-field `m h dom mon dow`). */
export function cronFor(expr: string, timezone: string): Cron {
  try {
    return new Cron(expr, { timezone, paused: true, mode: "5-part" });
  } catch (err) {
    throw new SwitchyardError(
      "invalid_request",
      `Invalid cron expression "${expr}" or timezone "${timezone}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Throws `invalid_request` for an unusable trigger. */
export function validateTrigger(trigger: Trigger): void {
  if (trigger.kind === "cron") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone });
    } catch {
      throw new SwitchyardError("invalid_request", `Unknown timezone "${trigger.timezone}"`);
    }
    if (trigger.expr.trim().split(/\s+/).length !== 5) {
      throw new SwitchyardError(
        "invalid_request",
        "Cron expressions need five fields: minute hour day-of-month month day-of-week",
      );
    }
    cronFor(trigger.expr, trigger.timezone);
  } else if (trigger.kind === "once" && Number.isNaN(Date.parse(trigger.at))) {
    throw new SwitchyardError("invalid_request", `Invalid timestamp "${trigger.at}"`);
  }
}

/** Next `n` occurrences strictly after `after`. */
export function nextOccurrences(trigger: Trigger, after: Date, n: number): string[] {
  if (trigger.kind === "cron") {
    return cronFor(trigger.expr, trigger.timezone)
      .nextRuns(n, after)
      .map((d) => d.toISOString());
  }
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return at.getTime() > after.getTime() ? [at.toISOString()] : [];
  }
  return [];
}

const pad = (n: number) => String(n).padStart(2, "0");
const isNum = (s: string) => /^\d+$/.test(s);

function listOf(field: string): number[] | null {
  const out: number[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (isNum(part)) out.push(Number(part));
    else return null;
  }
  return out;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function timePart(m: string, h: string): { text: string; frequency: boolean } | null {
  if (isNum(m) && h !== "*" && !h.includes("/")) {
    const hours = listOf(h);
    if (!hours) return null;
    return {
      text: `at ${hours.map((x) => `${pad(x)}:${pad(Number(m))}`).join(", ")}`,
      frequency: false,
    };
  }
  if (m === "*" && h === "*") return { text: "every minute", frequency: true };
  const mStep = /^\*\/(\d+)$/.exec(m);
  if (mStep && h === "*") return { text: `every ${mStep[1]} minutes`, frequency: true };
  if (isNum(m) && h === "*") {
    return { text: `every hour at minute ${Number(m)}`, frequency: true };
  }
  const hStep = /^\*\/(\d+)$/.exec(h);
  if (isNum(m) && hStep) {
    return { text: `every ${hStep[1]} hours at minute ${Number(m)}`, frequency: true };
  }
  return null;
}

function dayPart(dom: string, mon: string, dow: string): string | null {
  if (dom === "*" && mon === "*" && dow === "*") return "every day";
  if (dom === "*" && mon === "*") {
    const days = listOf(dow.replace(/\b7\b/g, "0"));
    if (!days) return null;
    const set = [...new Set(days)].sort();
    if (set.join(",") === "1,2,3,4,5") return "every weekday";
    if (set.join(",") === "0,6") return "every weekend day";
    return `every ${joinWords(set.map((d) => DAY_NAMES[d] ?? String(d)))}`;
  }
  if (dow === "*" && isNum(dom)) {
    if (mon === "*") return `on day ${Number(dom)} of every month`;
    const months = listOf(mon);
    if (!months) return null;
    return `on ${joinWords(months.map((x) => MONTH_NAMES[x - 1] ?? String(x)))} ${Number(dom)}`;
  }
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Human summary of a cron expression, e.g. "Every weekday at 09:00". Null when not covered. */
export function describeCron(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  const t = timePart(m, h);
  const d = dayPart(dom, mon, dow);
  if (!t || !d) return null;
  if (t.frequency) return d === "every day" ? cap(t.text) : `${cap(t.text)}, ${d}`;
  return `${cap(d)} ${t.text}`;
}

function formatInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Human-readable trigger summary for lists and the editor. */
export function describeTrigger(
  trigger: Trigger,
  lookupTaskTitle: (id: string) => string | undefined = () => undefined,
): string {
  switch (trigger.kind) {
    case "manual":
      return "Manually";
    case "once":
      return `Once on ${formatInZone(trigger.at, "UTC")} UTC`;
    case "webhook":
      return "When its webhook is called";
    case "dependency":
      return `When "${lookupTaskTitle(trigger.taskId) ?? trigger.taskId}" is done`;
    case "cron": {
      const d = describeCron(trigger.expr);
      return d ? `${d} (${trigger.timezone})` : `Cron "${trigger.expr}" (${trigger.timezone})`;
    }
  }
}

/** Timezone used for `{{date}}`/`{{time}}`: the cron's, else UTC. */
export function zoneOf(a: Pick<Automation, "trigger">): string {
  return a.trigger.kind === "cron" ? a.trigger.timezone : "UTC";
}

/** `{date: YYYY-MM-DD, time: HH:MM}` of an instant in a timezone. */
export function dateTimeIn(at: Date, timeZone: string): { date: string; time: string } {
  const [date, time] = formatInZone(at.toISOString(), timeZone).split(" ");
  return { date: date!, time: time! };
}
