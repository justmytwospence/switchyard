import {
  type AdapterContext,
  type Claim,
  defineAdapter,
  InteractionResponseError,
  type PiUiRequest,
  type PiUiResponse,
  type QueuedStep,
} from "@switchyard/adapter-sdk";
import { type Field, type FormValue, isFieldVisible } from "@switchyard/protocol";

/**
 * Adapter for @justmytwospence/pi-ask-user-question.
 *
 * In RPC mode the plugin asks its questions one dialog at a time:
 * - single select: `select("[header] question" + preview blocks, ["1. label - description", ...,
 *   "N. Type something."])`; choosing the last option opens `input("<title>\n\nType your answer:")`
 * - multi select: one `input` listing the numbered options, answered with "1,3"
 * - a question whose `showIf` is unmet gets no dialog.
 *
 * We claim the first dialog, show every question in one form, and turn the submitted form into
 * that exact dialog sequence: the first response answers the current dialog and the rest are
 * queued for the follow-up dialogs of the same tool call.
 */

export const TOOL_NAME = "ask_user_question";
export const OTHER_LABEL = "Type something.";
const PENDING = "pending:";
const NEVER_FIELD = "__unmet__";

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
  showIf?: { header: string; answers: string[] };
}
export interface AskArgs {
  questions: AskQuestion[];
}

interface Pending {
  toolCallId: string;
  args: AskArgs;
  claimed: boolean;
}

const isStr = (x: unknown): x is string => typeof x === "string";

/** Validate tool args against the plugin schema (questions 1..6, options 2..4). */
export function parseAskArgs(raw: unknown): AskArgs | undefined {
  const qs = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 6) return undefined;
  const questions: AskQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") return undefined;
    const { question, header, options, multiSelect, showIf } = q as Record<string, unknown>;
    if (!isStr(question) || !isStr(header) || !Array.isArray(options)) return undefined;
    if (options.length < 2 || options.length > 4) return undefined;
    const opts: AskOption[] = [];
    for (const o of options) {
      const { label, description, preview } = (o ?? {}) as Record<string, unknown>;
      if (!isStr(label)) return undefined;
      opts.push({
        label,
        description: isStr(description) ? description : "",
        ...(isStr(preview) ? { preview } : {}),
      });
    }
    let cond: AskQuestion["showIf"];
    if (showIf && typeof showIf === "object") {
      const { header: h, answers } = showIf as Record<string, unknown>;
      if (!isStr(h) || !Array.isArray(answers) || !answers.every(isStr)) return undefined;
      cond = { header: h, answers };
    }
    questions.push({
      question,
      header,
      options: opts,
      ...(multiSelect === true ? { multiSelect: true } : {}),
      ...(cond ? { showIf: cond } : {}),
    });
  }
  return { questions };
}

export const fieldName = (i: number) => `q${i + 1}`;

/** One form field per question; showIf maps to Field.showIf on the referenced earlier field. */
export function questionFields(args: AskArgs): Field[] {
  return args.questions.map((q, i): Field => {
    const options = q.options.map((o) => ({
      value: o.label,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      ...(o.preview !== undefined ? { preview: o.preview } : {}),
    }));
    let showIf: Field["showIf"];
    if (q.showIf) {
      const ref = args.questions.findIndex((p, j) => j < i && p.header === q.showIf!.header);
      // The plugin evaluates showIf against earlier answers; a missing reference never matches.
      showIf =
        ref === -1
          ? { field: NEVER_FIELD, values: [] }
          : { field: fieldName(ref), values: q.showIf.answers };
    }
    const base = { name: fieldName(i), label: q.question, options, ...(showIf ? { showIf } : {}) };
    return q.multiSelect
      ? { kind: "multiselect", ...base, min: 1 }
      : { kind: "select", ...base, allowOther: { label: OTHER_LABEL } };
  });
}

/** The option string Pi offers for 1-based option `n` (matched by its "n." prefix). */
function optionNumbered(options: string[], n: number): string | undefined {
  const re = new RegExp(`^${n}\\.(\\s|$)`);
  return options.find((o) => re.test(o));
}

function otherOption(options: string[]): string | undefined {
  return options.find((o) => /^\d+\.\s*Type something\.?\s*$/.test(o)) ?? options.at(-1);
}

function belongsTo(q: AskQuestion) {
  return (req: PiUiRequest) =>
    req.title.includes(`[${q.header}]`) || req.title.includes(q.question.trim());
}

/** Map a submitted form to the plugin's dialog sequence. */
export function answerSequence(
  args: AskArgs,
  values: Record<string, FormValue>,
): (PiUiResponse | QueuedStep)[] {
  const fields = questionFields(args);
  const steps: QueuedStep[] = [];
  args.questions.forEach((q, i) => {
    if (!isFieldVisible(fields[i]!, values)) return;
    const v = values[fieldName(i)];
    const owns = belongsTo(q);
    if (q.multiSelect) {
      if (!Array.isArray(v) || v.length === 0) {
        throw new InteractionResponseError(`"${q.question}": choose at least one option`);
      }
      const nums = v.map((label) => {
        const idx = q.options.findIndex((o) => o.label === label);
        if (idx === -1)
          throw new InteractionResponseError(`"${q.question}": unknown option ${label}`);
        return idx + 1;
      });
      const answer = [...new Set(nums)].sort((a, b) => a - b).join(",");
      steps.push({
        match: (req) => req.method === "input" && owns(req),
        response: { value: answer },
      });
      return;
    }
    if (typeof v === "string") {
      const n = q.options.findIndex((o) => o.label === v) + 1;
      if (n === 0) throw new InteractionResponseError(`"${q.question}": unknown option ${v}`);
      steps.push({
        match: (req) => req.method === "select" && owns(req),
        response: (req) => {
          const opt = req.method === "select" ? optionNumbered(req.options, n) : undefined;
          return opt === undefined ? undefined : { value: opt };
        },
      });
      return;
    }
    if (v && !Array.isArray(v) && typeof v.other === "string" && v.other.trim()) {
      steps.push({
        match: (req) => req.method === "select" && owns(req),
        response: (req) => {
          const opt = req.method === "select" ? otherOption(req.options) : undefined;
          return opt === undefined ? undefined : { value: opt };
        },
      });
      steps.push({
        match: (req) => req.method === "input" && req.title.includes("Type your answer"),
        response: { value: v.other },
      });
      return;
    }
    throw new InteractionResponseError(`"${q.question}" needs an answer`);
  });
  return steps;
}

/** The question the plugin asks first: the first one without a showIf condition. */
function firstAsked(args: AskArgs): AskQuestion | undefined {
  return args.questions.find((q) => !q.showIf);
}

function matchesFirstDialog(args: AskArgs, req: PiUiRequest): boolean {
  const q = firstAsked(args);
  if (!q || !req.title.startsWith(`[${q.header}]`)) return false;
  if (q.multiSelect) return req.method === "input";
  if (req.method !== "select") return false;
  return (
    req.options.length === q.options.length + 1 &&
    q.options.every((_, i) => optionNumbered(req.options, i + 1) !== undefined)
  );
}

function pendingCalls(ctx: AdapterContext): Pending[] {
  return ctx.state
    .keys()
    .filter((k) => k.startsWith(PENDING))
    .map((k) => ctx.state.get<Pending>(k)!)
    .filter(Boolean);
}

export function buildClaim(pending: Pending): Claim {
  const { args, toolCallId } = pending;
  const n = args.questions.length;
  const first = args.questions[0]!;
  return {
    title:
      n === 1 ? first.question : `${first.header} and ${n - 1} more question${n > 2 ? "s" : ""}`,
    ownerToolCallId: toolCallId,
    presentation: {
      t: "form",
      formId: `ask-user-question:${toolCallId}`,
      fields: questionFields(args),
      submitLabel: "Submit answers",
      cancelLabel: "Cancel",
    },
    toPiResponse(resp) {
      if (resp.kind === "cancel") return { cancelled: true };
      if (resp.kind !== "form") {
        throw new InteractionResponseError(`expected the question form, got ${resp.kind}`);
      }
      return { sequence: answerSequence(args, resp.values) };
    },
  };
}

export default defineAdapter({
  onToolStart(e, ctx) {
    if (e.name !== TOOL_NAME) return;
    const args = parseAskArgs(e.args);
    if (!args) {
      ctx.log(
        "warning",
        `ask_user_question ${e.toolCallId}: unrecognized arguments; using generic dialogs`,
      );
      return;
    }
    ctx.state.set(`${PENDING}${e.toolCallId}`, { toolCallId: e.toolCallId, args, claimed: false });
  },

  onToolEnd(e, ctx) {
    if (e.name === TOOL_NAME) ctx.state.delete(`${PENDING}${e.toolCallId}`);
  },

  claimInteraction(req, ctx) {
    if (req.method !== "select" && req.method !== "input") return undefined;
    const candidates = pendingCalls(ctx).reverse();
    const pending = candidates.find((p) => !p.claimed && matchesFirstDialog(p.args, req));
    if (!pending) return undefined;
    ctx.state.set(`${PENDING}${pending.toolCallId}`, { ...pending, claimed: true });
    return buildClaim(pending);
  },
});
