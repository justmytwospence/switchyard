import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import type { WorkerJob, WorkerReply } from "../src/policies/evaluator.js";
import { policyContext, policyRule } from "./policy-evaluator-fixtures.js";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()));
});
async function start() {
  const worker = new Worker(new URL("../dist/policies/worker.js", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
  });
  workers.push(worker);
  expect((await once(worker, "message"))[0]).toEqual({ type: "ready" });
  let id = 0;
  return async (job: WorkerJob): Promise<WorkerReply> => {
    const reply = once(worker, "message");
    worker.postMessage({ id: ++id, job });
    const [result] = await reply;
    expect(result.id).toBe(id);
    return result;
  };
}

it("caches callable by immutable id/revision, without caching results or counters", async () => {
  const send = await start();
  const rule = policyRule('{"verdict":"ALLOW","reason":"","state_updates":{"n":counters.n+1}}');
  expect(await send({ type: "validate", rule })).toMatchObject({
    type: "result",
    value: { valid: true },
  });
  for (const n of [1, 20, -5]) {
    expect(
      await send({
        type: "evaluate",
        rules: [rule],
        context: policyContext(),
        countersByRule: { rule: { n } },
      }),
    ).toMatchObject({
      type: "result",
      value: [{ result: { verdict: "ALLOW", state_updates: { n: n + 1 } } }],
    });
  }
  const edited = { ...rule, expression: "null" };
  expect(await send({ type: "validate", rule: edited })).toMatchObject({
    type: "result",
    value: { valid: false, error: { kind: "type" } },
  });
  expect(await send({ type: "validate", rule: { ...edited, revision: 2 } })).toMatchObject({
    type: "result",
    value: { valid: true },
  });
});

it("exposes only the nine fixed variables and no custom I/O functions", async () => {
  const send = await start();
  for (const expression of [
    "process.env",
    "fetch('https://example.com')",
    "require('fs')",
    "transcript",
    "model_request",
  ]) {
    expect(await send({ type: "validate", rule: policyRule(expression) })).toMatchObject({
      type: "result",
      value: { valid: false, error: { kind: "type" } },
    });
  }
});

it("validates off-thread and never evaluates a runtime-failing rule during compilation", async () => {
  const send = await start();
  const rule = policyRule('{"verdict":"ALLOW","reason":string(1 / int(tool.args.zero))}');
  expect(await send({ type: "validate", rule })).toMatchObject({
    type: "result",
    value: { valid: true },
  });
  const context = policyContext();
  context.tool!.args = { zero: 0 };
  expect(
    await send({ type: "evaluate", rules: [rule], context, countersByRule: {} }),
  ).toMatchObject({
    type: "result",
    value: [{ result: null, error: { kind: "runtime" } }],
  });
});
