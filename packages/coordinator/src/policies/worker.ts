import { parentPort } from "node:worker_threads";
import { type ASTNode, Environment, type ParseResult } from "@marcbachmann/cel-js";
import {
  PolicyContext,
  PolicyCounterMap,
  PolicyRule,
  PolicyRuleResult,
} from "@switchyard/protocol";
import type { EvaluatedRule, PolicyEngineError } from "./contracts.js";
import {
  checkPolicyJson,
  PolicyEvaluatorError,
  type WorkerJob,
  type WorkerReply,
} from "./evaluator.js";

const env = new Environment({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: false,
  limits: {
    maxAstNodes: 2000,
    maxDepth: 40,
    maxListElements: 100,
    maxMapEntries: 100,
    maxCallArguments: 16,
  },
});
for (const name of [
  "phase",
  "action",
  "tool",
  "request",
  "session",
  "task",
  "target",
  "cost",
  "counters",
]) {
  env.registerVariable(
    name,
    name === "phase" || name === "action"
      ? "string"
      : name === "counters"
        ? "map<string, int>"
        : "dyn",
  );
}

// LRU bounds retention as well as worker heap. A revision is immutable: never reuse
// a cached callable for different source under the same id/revision.
const cache = new Map<string, { expression: string; callable: ParseResult; returnType: string }>();
function compile(rule: PolicyRule): { callable: ParseResult; returnType: string } {
  const key = JSON.stringify([rule.id, rule.revision]);
  const cached = cache.get(key);
  if (cached) {
    if (cached.expression !== rule.expression)
      throw new PolicyEvaluatorError({
        kind: "type",
        message: "Policy expression changed without a new revision.",
        range: null,
      });
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let callable: ParseResult;
  try {
    callable = env.parse(rule.expression);
  } catch (error) {
    throw new PolicyEvaluatorError(diagnostic(error, "parse"));
  }
  checkMapKeys(callable.ast);
  const checked = callable.check();
  if (!checked.valid) throw new PolicyEvaluatorError(diagnostic(checked.error, "type"));
  const returnType = checked.type === "null" ? "null_type" : checked.type!;
  if (
    returnType !== "null_type" &&
    returnType !== "dyn" &&
    returnType !== "map" &&
    !returnType.startsWith("map<")
  )
    throw new PolicyEvaluatorError({
      kind: "type",
      message: "Policy expression must return null or a verdict map.",
      range: null,
    });
  cache.set(key, { expression: rule.expression, callable, returnType });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  return { callable, returnType };
}

// cel-js omits these literal keys when building objects. Reject rather than
// silently accepting a rule whose proposed update was discarded by the library.
function checkMapKeys(node: ASTNode): void {
  if (node.op === "map") {
    for (const [key] of node.args) {
      if (
        key.op === "value" &&
        ["__proto__", "prototype", "constructor"].includes(String(key.args))
      )
        throw new PolicyEvaluatorError({
          kind: "type",
          message: "Policy maps contain a forbidden key.",
          range: key.range,
        });
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object" && "op" in value && "args" in value)
      checkMapKeys(value as ASTNode);
  };
  visit(node.args);
}

function diagnostic(error: unknown, kind: PolicyEngineError["kind"]): PolicyEngineError {
  if (error instanceof PolicyEvaluatorError) return error.failure;
  const e = error as { message?: string; range?: { start: number; end: number } } | undefined;
  return {
    kind,
    message: (e?.message || "Policy evaluation failed.").slice(0, 4000),
    range: e?.range ? { start: e.range.start, end: e.range.end } : null,
  };
}

/** Safe integral JSON values become CEL int, except the two USD double fields.
 * Fractional JSON numbers remain double; integral custom tool/request JSON is int.
 */
function toCel(value: unknown, path: string[] = []): unknown {
  if (typeof value === "number") {
    const usd =
      path.length === 2 &&
      path[0] === "cost" &&
      (path[1] === "costUsd" || path[1] === "maxCostUsd");
    return Number.isInteger(value) && !usd ? BigInt(value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => toCel(v, [...path, String(i)]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toCel(v, [...path, k])]));
}

function fromCel(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error("Policy result exceeds depth 20.");
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new Error("Policy result integer is outside the safe JSON range.");
    return Number(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map((v) => fromCel(v, depth + 1));
  if (value instanceof Map) {
    if ([...value.keys()].some((key) => typeof key !== "string"))
      throw new Error("Policy result map keys must be strings.");
    return Object.fromEntries([...value].map(([key, v]) => [key, fromCel(v, depth + 1)]));
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Policy result must be JSON.");
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromCel(v, depth + 1)]));
}

function evaluate(job: Extract<WorkerJob, { type: "evaluate" }>): EvaluatedRule[] {
  checkPolicyJson(job.rules, 2 * 1024 * 1024);
  checkPolicyJson(job.context, 65536, true);
  checkPolicyJson(job.countersByRule, 2 * 1024 * 1024);
  if (Buffer.byteLength(JSON.stringify(job)) > 2 * 1024 * 1024)
    throw new PolicyEvaluatorError({
      kind: "limit",
      message: "Policy input is too large to evaluate.",
      range: null,
    });
  const rules = job.rules.map((r) => PolicyRule.parse(r));
  if (rules.filter((r) => r.enabled).length > 128)
    throw new Error("At most 128 enabled policy rules may be evaluated.");
  // Validate even an empty rule set: malformed input cannot become an implicit ALLOW.
  PolicyContext.parse({ ...job.context, counters: {} });
  return rules.map((rule) => {
    const identity = { ruleId: rule.id, ruleRevision: rule.revision };
    if (!rule.enabled || !rule.phases.includes(job.context.phase))
      return { ...identity, result: null, error: null };
    try {
      const counters = PolicyCounterMap.parse(
        Object.hasOwn(job.countersByRule, rule.id) ? job.countersByRule[rule.id] : {},
      );
      const input = { ...job.context, counters };
      checkPolicyJson(input, 65536, true);
      const context = PolicyContext.parse(input);
      const { callable } = compile(rule);
      let raw: unknown;
      try {
        raw = callable(toCel(context) as Record<string, unknown>);
      } catch (error) {
        throw new PolicyEvaluatorError(diagnostic(error, "runtime"));
      }
      try {
        if (raw && typeof raw === "object" && "state_updates" in raw) {
          const updates = raw.state_updates;
          if (
            !updates ||
            typeof updates !== "object" ||
            Array.isArray(updates) ||
            (updates instanceof Map ? [...updates.values()] : Object.values(updates)).some(
              (v) => typeof v !== "bigint",
            )
          )
            throw new Error("Policy state_updates must be a map of CEL int values.");
        }
        const result = fromCel(raw);
        checkPolicyJson(result, 65536);
        const parsed = PolicyRuleResult.parse(result);
        // A patch may replace keys, but must not grow this rule's state beyond 64 keys.
        if (parsed?.state_updates) PolicyCounterMap.parse({ ...counters, ...parsed.state_updates });
        return { ...identity, result: parsed, error: null };
      } catch (error) {
        throw new PolicyEvaluatorError(diagnostic(error, "runtime"));
      }
    } catch (error) {
      return { ...identity, result: null, error: diagnostic(error, "type") };
    }
  });
}

if (parentPort) {
  const port = parentPort;
  port.on("message", ({ id, job }: { id: number; job: WorkerJob }) => {
    let reply: WorkerReply;
    try {
      if (job.type === "validate") {
        try {
          checkPolicyJson(job.rule, 2 * 1024 * 1024);
          const { returnType } = compile(PolicyRule.parse(job.rule));
          reply = { type: "result", id, value: { valid: true, returnType } };
        } catch (error) {
          reply = {
            type: "result",
            id,
            value: { valid: false, error: diagnostic(error, "type") },
          };
        }
      } else reply = { type: "result", id, value: evaluate(job) };
    } catch (error) {
      reply = { type: "failure", id, error: diagnostic(error, "type") };
    }
    port.postMessage(reply);
  });
  port.postMessage({ type: "ready" } satisfies WorkerReply);
}
