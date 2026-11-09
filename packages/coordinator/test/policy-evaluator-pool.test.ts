import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import { policyContext, policyRule } from "./policy-evaluator-fixtures.js";

const state = vi.hoisted(() => ({
  existingCandidate: 0,
  constructorFails: false,
  candidates: [] as string[],
  workers: [] as Array<{
    url: URL;
    emit: (event: string, ...args: unknown[]) => boolean;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    options: { resourceLimits: { maxOldGenerationSizeMb: number; stackSizeMb: number } };
  }>,
}));
vi.mock("node:fs", () => ({
  existsSync: (url: URL) => {
    state.candidates.push(url.pathname);
    const call = state.candidates.length - 1;
    return (
      state.existingCandidate >= 0 &&
      call % (state.existingCandidate + 1) === state.existingCandidate
    );
  },
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      terminate = vi.fn(async () => 0);
      ref = vi.fn();
      unref = vi.fn();
      constructor(
        readonly url: URL,
        readonly options: {
          resourceLimits: { maxOldGenerationSizeMb: number; stackSizeMb: number };
        },
      ) {
        super();
        if (state.constructorFails) throw new Error("No worker available");
        state.workers.push(this);
      }
    },
  };
});
let pool: PolicyEvaluator;
beforeEach(() => {
  vi.useFakeTimers();
  state.workers.length = 0;
  state.candidates.length = 0;
  state.existingCandidate = 0;
  state.constructorFails = false;
  pool = new PolicyEvaluator();
});
afterEach(async () => {
  await pool.close();
  vi.useRealTimers();
});
const ready = (i: number) => state.workers[i].emit("message", { type: "ready" });
const finish = (i: number) => {
  const calls = state.workers[i].postMessage.mock.calls;
  const { id } = calls[calls.length - 1][0];
  state.workers[i].emit("message", {
    type: "result",
    id,
    value: { valid: true, returnType: "map<string, string>" },
  });
};

it("uses exactly two workers, bounded resources, and one job per ready worker", async () => {
  const promises = Array.from({ length: 3 }, () => pool.validateRule(policyRule()));
  expect(state.workers).toHaveLength(2);
  for (const worker of state.workers) {
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 64, stackSizeMb: 4 });
    expect(worker.postMessage).not.toHaveBeenCalled();
  }
  ready(0);
  ready(1);
  expect(state.workers[0].postMessage).toHaveBeenCalledTimes(1);
  expect(state.workers[1].postMessage).toHaveBeenCalledTimes(1);
  finish(0);
  expect(state.workers[0].postMessage).toHaveBeenCalledTimes(2);
  finish(0);
  finish(1);
  expect(await Promise.all(promises)).toEqual([
    { valid: true, returnType: "map<string, string>" },
    { valid: true, returnType: "map<string, string>" },
    { valid: true, returnType: "map<string, string>" },
  ]);
});

it("starts the 250-ms deadline only after worker-ready, separate from 5-second startup", async () => {
  const result = pool.validateRule(policyRule());
  vi.advanceTimersByTime(4999);
  expect(state.workers[0].terminate).not.toHaveBeenCalled();
  ready(0);
  ready(1);
  vi.advanceTimersByTime(249);
  expect(state.workers[0].terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(await result).toMatchObject({ valid: false, error: { kind: "timeout" } });
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(state.workers).toHaveLength(3);
});

it("fails queued work at the startup deadline without an endless restart loop", async () => {
  const result = pool.validateRule(policyRule());
  vi.advanceTimersByTime(5000);
  expect(await result).toMatchObject({
    valid: false,
    error: { kind: "timeout", message: expect.stringContaining("startup") },
  });
  expect(state.workers).toHaveLength(2);
  expect(state.workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
});

it("caps waiting work at 256, in addition to the two active jobs", async () => {
  const active = [pool.validateRule(policyRule()), pool.validateRule(policyRule())];
  ready(0);
  ready(1);
  const queued = Array.from({ length: 256 }, () => pool.validateRule(policyRule()));
  expect(await pool.validateRule(policyRule())).toMatchObject({
    valid: false,
    error: { kind: "limit" },
  });
  await pool.close();
  for (const result of await Promise.all([...active, ...queued]))
    expect(result).toMatchObject({ valid: false, error: { kind: "worker" } });
});

it("replaces a crashed worker and fails its job without synthesizing ALLOW", async () => {
  const result = pool.validateRule(policyRule());
  ready(0);
  ready(1);
  state.workers[0].emit("error", new Error("heap limit"));
  state.workers[0].emit("exit", 1);
  expect(await result).toMatchObject({ valid: false, error: { kind: "worker" } });
  expect(state.workers).toHaveLength(3);
  const next = pool.validateRule(policyRule());
  finish(1);
  expect(await next).toEqual({ valid: true, returnType: "map<string, string>" });
});

it("rejects pending evaluation and validation on close and terminates both workers", async () => {
  const validation = pool.validateRule(policyRule());
  const evaluation = pool.evaluateRules([policyRule()], policyContext(), {}).catch((e) => e);
  ready(0);
  await pool.close();
  expect(await validation).toMatchObject({ valid: false, error: { kind: "worker" } });
  expect(await evaluation).toMatchObject([
    { result: null, error: { kind: "worker", range: null } },
  ]);
  expect(state.workers.every((w) => w.terminate.mock.calls.length === 1)).toBe(true);
});

it("snapshots queued rules and context before the caller can mutate them", async () => {
  const context = policyContext();
  const rule = policyRule();
  const result = pool.evaluateRules([rule], context, {}).catch((e) => e);
  context.tool!.args = { changed: true };
  rule.expression = "null";
  ready(0);
  const job = state.workers[0].postMessage.mock.calls[0][0].job;
  expect(job.context.tool.args).toEqual({});
  expect(job.rules[0].expression).toContain("ALLOW");
  await pool.close();
  await result;
});

it.each([0, 1, 2])(
  "uses the first existing compiled/npm/source-test worker candidate (%s)",
  async (candidate) => {
    state.existingCandidate = candidate;
    const result = pool.validateRule(policyRule());
    expect(state.workers[0].url.pathname).toContain(
      candidate === 0
        ? "/src/policies/worker.js"
        : candidate === 1
          ? "/src/policies/policies/worker.js"
          : "/dist/policies/worker.js",
    );
    ready(0);
    ready(1);
    finish(0);
    expect((await result).valid).toBe(true);
  },
);

it("fails clearly when the compiled worker is absent, without a main-thread fallback", async () => {
  state.existingCandidate = -1;
  expect(await pool.validateRule(policyRule())).toMatchObject({
    valid: false,
    error: {
      kind: "worker",
      message: expect.stringContaining("Policy worker is missing"),
      range: null,
    },
  });
  expect(state.workers).toHaveLength(0);
});

it("handles worker construction failure even from a ready callback", async () => {
  const result = pool.validateRule(policyRule());
  state.workers[1].emit("exit", 1);
  state.constructorFails = true;
  expect(() => ready(0)).not.toThrow();
  expect(await result).toMatchObject({ valid: false, error: { kind: "worker" } });
});
