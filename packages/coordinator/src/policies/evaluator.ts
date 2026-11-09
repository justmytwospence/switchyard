import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PolicyContext, PolicyCounterMap, PolicyRule } from "@switchyard/protocol";

import type { EvaluatedRule, PolicyEngineError, Validation } from "./contracts.js";

/** Internal transport exception; public methods return the D.2 error contract. */
export class PolicyEvaluatorError extends Error {
  constructor(readonly failure: PolicyEngineError) {
    super(failure.message);
    this.name = "PolicyEvaluatorError";
  }
}

export type WorkerJob =
  | { type: "validate"; rule: PolicyRule }
  | {
      type: "evaluate";
      rules: PolicyRule[];
      context: Omit<PolicyContext, "counters">;
      countersByRule: Record<string, PolicyCounterMap>;
    };
export type WorkerReply =
  | { type: "ready" }
  | { type: "result"; id: number; value: Validation | EvaluatedRule[] }
  | { type: "failure"; id: number; error: PolicyEngineError };

type Job = {
  id: number;
  input: WorkerJob;
  resolve: (value: Validation | EvaluatedRule[]) => void;
  reject: (error: PolicyEvaluatorError) => void;
};
type Slot = { worker: Worker; ready: boolean; job?: Job; timer?: NodeJS.Timeout };
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fail = (kind: PolicyEngineError["kind"], message: string) =>
  new PolicyEvaluatorError({ kind, message, range: null });

/** Internal JSON boundary, also used defensively by the worker before schema parsing. */
export function checkPolicyJson(value: unknown, maxBytes: number, context = false): number {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (n: number) => {
    bytes += n;
    if (bytes > maxBytes) throw fail("limit", "Policy input is too large to evaluate.");
  };
  const visit = (v: unknown, path: string[]) => {
    if (path.length > 20) throw fail("limit", "Policy input exceeds depth 20.");
    if (v === null || typeof v === "boolean") return add(v === null ? 4 : v ? 4 : 5);
    if (typeof v === "string") return add(Buffer.byteLength(JSON.stringify(v)));
    if (typeof v === "number") {
      const usd =
        context &&
        path.length === 2 &&
        path[0] === "cost" &&
        (path[1] === "costUsd" || path[1] === "maxCostUsd");
      if (!Number.isFinite(v) || (!usd && Number.isInteger(v) && !Number.isSafeInteger(v)))
        throw fail("limit", "Policy numbers must be finite and integers must be safe.");
      return add(Buffer.byteLength(JSON.stringify(v)));
    }
    if (typeof v !== "object" || ancestors.has(v))
      throw fail("limit", "Policy input must be acyclic JSON.");
    const array = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(v) !== null
    )
      throw fail("limit", "Policy input must contain only plain JSON objects.");
    if (Object.getOwnPropertySymbols(v).length)
      throw fail("limit", "Policy input has symbol keys.");
    const keys = Object.getOwnPropertyNames(v).filter((k) => !array || k !== "length");
    if (array && (keys.length !== v.length || keys.some((k, i) => k !== String(i))))
      throw fail("limit", "Policy input must contain dense JSON arrays.");
    ancestors.add(v);
    add(2);
    for (const [i, key] of keys.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (forbidden.has(key) || !descriptor.enumerable || !("value" in descriptor))
        throw fail("limit", "Policy input has a forbidden key or non-JSON property.");
      if (i) add(1);
      if (!array) add(Buffer.byteLength(JSON.stringify(key)) + 1);
      visit(descriptor.value, [...path, key]);
    }
    ancestors.delete(v);
  };
  visit(value, []);
  return bytes;
}

function workerUrl(): URL {
  for (const path of ["./worker.js", "./policies/worker.js", "../../dist/policies/worker.js"]) {
    const url = new URL(path, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw fail(
    "worker",
    "Policy worker is missing. Build the coordinator before evaluating policies.",
  );
}

/** Bounded, lazily started two-worker pool. Close it during coordinator shutdown. */
export class PolicyEvaluator {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private sequence = 0;
  private closed = false;
  private closing?: Promise<void>;
  private terminations = new Set<Promise<number>>();

  /** Parse and type-check off-thread. Does not evaluate the expression or change counters. */
  async validateRule(rule: PolicyRule): Promise<Validation> {
    try {
      checkPolicyJson(rule, 2 * 1024 * 1024);
      return (await this.submit({ type: "validate", rule })) as Validation;
    } catch (error) {
      return {
        valid: false,
        error:
          error instanceof PolicyEvaluatorError
            ? error.failure
            : {
                kind: "worker",
                message: "Policy validation failed.",
                range: null,
              },
      };
    }
  }

  /** One result per supplied rule, in order. Inapplicable rules are no-match.
   * Rule state is isolated by id; pool/input failures return result:null,error for every rule.
   */
  async evaluateRules(
    rules: PolicyRule[],
    context: Omit<PolicyContext, "counters">,
    countersByRule: Record<string, PolicyCounterMap>,
  ): Promise<EvaluatedRule[]> {
    // A sparse/non-array input has no rule identity for each result. Reject it
    // before allocating by its declared length; valid PolicyRule[] is dense.
    if (!Array.isArray(rules) || Object.keys(rules).length !== rules.length)
      throw fail("limit", "Policy rules must be a dense JSON array.");
    // Read only data descriptors, never accessors, and retain identity across awaits.
    const identities = Array.isArray(rules)
      ? Array.from({ length: rules.length }, (_, i) => {
          const rule = Object.getOwnPropertyDescriptor(rules, String(i))?.value;
          return {
            ruleId:
              rule && typeof rule === "object"
                ? Object.getOwnPropertyDescriptor(rule, "id")?.value
                : "",
            ruleRevision:
              rule && typeof rule === "object"
                ? Object.getOwnPropertyDescriptor(rule, "revision")?.value
                : 0,
          };
        })
      : [];
    try {
      const ruleBytes = checkPolicyJson(rules, 2 * 1024 * 1024);
      const contextBytes = checkPolicyJson(context, 65536, true);
      const counterBytes = checkPolicyJson(countersByRule, 2 * 1024 * 1024);
      if (
        !Array.isArray(rules) ||
        rules.some((rule) => !rule || typeof rule !== "object") ||
        !context ||
        typeof context !== "object" ||
        Array.isArray(context) ||
        !countersByRule ||
        typeof countersByRule !== "object" ||
        Array.isArray(countersByRule)
      )
        throw fail("limit", "Invalid policy evaluation input.");
      if (ruleBytes + contextBytes + counterBytes > 2 * 1024 * 1024)
        throw fail("limit", "Policy input is too large to evaluate.");
      if (rules.filter((rule) => rule.enabled).length > 128)
        throw fail("limit", "At most 128 enabled policy rules may be evaluated.");
      for (const rule of rules) {
        if (!rule.enabled) continue;
        const counters = Object.hasOwn(countersByRule, rule.id) ? countersByRule[rule.id] : {};
        checkPolicyJson({ ...context, counters }, 65536, true);
      }
      return (await this.submit({
        type: "evaluate",
        rules,
        context,
        countersByRule,
      })) as EvaluatedRule[];
    } catch (error) {
      const failure =
        error instanceof PolicyEvaluatorError
          ? error.failure
          : {
              kind: "worker" as const,
              message: "Policy evaluator failed.",
              range: null,
            };
      return identities.map((identity) => ({ ...identity, result: null, error: failure }));
    }
  }

  private submit(input: WorkerJob): Promise<Validation | EvaluatedRule[]> {
    if (this.closed) return Promise.reject(fail("worker", "Policy evaluator is closed."));
    if (this.queue.length >= 256)
      return Promise.reject(fail("limit", "Policy evaluator queue is full."));
    // Snapshot before yielding: a caller cannot change queued arguments after validation.
    const json = JSON.stringify(input);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024)
      return Promise.reject(fail("limit", "Policy input is too large to evaluate."));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, input: JSON.parse(json), resolve, reject });
      this.fill();
    });
  }

  private fill() {
    if (this.closed) return;
    try {
      while (this.slots.length < 2) this.start();
    } catch (error) {
      this.rejectQueue(
        error instanceof PolicyEvaluatorError
          ? error
          : fail("worker", "Policy worker could not be started."),
      );
      for (const slot of this.slots) if (slot.ready && !slot.job) slot.worker.unref();
      return;
    }
    for (const slot of this.slots) {
      if (!slot.ready || slot.job) continue;
      const job = this.queue.shift();
      if (!job) {
        slot.worker.unref();
        continue;
      }
      slot.job = job;
      slot.worker.ref();
      slot.timer = setTimeout(
        () => this.broken(slot, fail("timeout", "Policy evaluation exceeded 250 ms.")),
        250,
      );
      try {
        slot.worker.postMessage({ id: job.id, job: job.input });
      } catch {
        this.broken(slot, fail("worker", "Policy worker could not accept the job."));
      }
    }
  }

  private start() {
    const worker = new Worker(workerUrl(), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const slot: Slot = { worker, ready: false };
    this.slots.push(slot);
    slot.timer = setTimeout(
      () => this.broken(slot, fail("timeout", "Policy worker startup exceeded 5 seconds.")),
      5000,
    );
    worker.on("message", (reply: WorkerReply) => {
      if (!this.slots.includes(slot)) return;
      if (reply.type === "ready" && !slot.ready) {
        clearTimeout(slot.timer);
        slot.ready = true;
        this.fill();
      } else if (slot.ready && slot.job && reply.type !== "ready" && reply.id === slot.job.id) {
        clearTimeout(slot.timer);
        const job = slot.job;
        slot.job = undefined;
        if (reply.type === "failure") job.reject(new PolicyEvaluatorError(reply.error));
        else job.resolve(reply.value);
        this.fill();
      } else this.broken(slot, fail("worker", "Invalid policy worker response."));
    });
    worker.on("error", () =>
      this.broken(slot, fail("worker", "Policy worker failed or exceeded its resource limits.")),
    );
    worker.on("exit", () =>
      this.broken(slot, fail("worker", "Policy worker exited unexpectedly.")),
    );
  }

  private rejectQueue(error: PolicyEvaluatorError) {
    for (const job of this.queue.splice(0)) job.reject(error);
  }

  private broken(slot: Slot, error: PolicyEvaluatorError) {
    if (!this.slots.includes(slot)) return;
    this.slots.splice(this.slots.indexOf(slot), 1);
    clearTimeout(slot.timer);
    slot.job?.reject(error);
    this.terminate(slot.worker);
    // Failed startup must settle queued callers, not retry them forever.
    if (!slot.ready) this.rejectQueue(error);
    if (!this.closed && slot.ready) this.fill();
  }

  private terminate(worker: Worker) {
    const pending = worker.terminate();
    this.terminations.add(pending);
    void pending.then(
      () => this.terminations.delete(pending),
      () => this.terminations.delete(pending),
    );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const error = fail("worker", "Policy evaluator is closed.");
    this.rejectQueue(error);
    for (const slot of this.slots.splice(0)) {
      clearTimeout(slot.timer);
      slot.job?.reject(error);
      this.terminate(slot.worker);
    }
    this.closing = Promise.all(this.terminations).then(() => undefined);
    return this.closing;
  }
}

const evaluator = new PolicyEvaluator();
export const validateRule = (rule: PolicyRule): Promise<Validation> => evaluator.validateRule(rule);
export const evaluateRules = (
  rules: PolicyRule[],
  context: Omit<PolicyContext, "counters">,
  countersByRule: Record<string, PolicyCounterMap>,
): Promise<EvaluatedRule[]> => evaluator.evaluateRules(rules, context, countersByRule);
/** Shutdown hook for the module-level evaluator; instances can instead call close(). */
export const closeEvaluator = (): Promise<void> => evaluator.close();
