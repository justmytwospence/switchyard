import type { PolicyContext, PolicyRule } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyEvaluator } from "../src/policies/evaluator.js";
import { policyContext, policyRule } from "./policy-evaluator-fixtures.js";

const pools: PolicyEvaluator[] = [];
function evaluator() {
  const pool = new PolicyEvaluator();
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe("bounded CEL evaluator", () => {
  it("distinguishes no match, ALLOW, ASK and DENY without committing updates", async () => {
    const pool = evaluator();
    const counters = { allow: { seen: 3 } };
    const result = await pool.evaluateRules(
      [
        policyRule("null", { id: "none" }),
        policyRule('{"verdict":"ALLOW","reason":"","state_updates":{"seen":counters.seen+1}}', {
          id: "allow",
        }),
        policyRule('{"verdict":"ASK","reason":"approval"}', { id: "ask" }),
        policyRule('{"verdict":"DENY","reason":"blocked"}', { id: "deny" }),
      ],
      policyContext(),
      counters,
    );
    expect(result.map((r) => r.result)).toEqual([
      null,
      { verdict: "ALLOW", reason: "", state_updates: { seen: 4 } },
      { verdict: "ASK", reason: "approval" },
      { verdict: "DENY", reason: "blocked" },
    ]);
    expect(counters).toEqual({ allow: { seen: 3 } });
  });

  it("gives each rule only its own counters, with an empty map for a missing id", async () => {
    const expr =
      '{"verdict":"ALLOW","reason":"","state_updates":{"n":has(counters.n) ? counters.n+1 : 1}}';
    const result = await evaluator().evaluateRules(
      [
        policyRule(expr, { id: "one" }),
        policyRule(expr, { id: "two" }),
        policyRule(expr, { id: "missing" }),
      ],
      policyContext(),
      { one: { n: 5 }, two: { n: 20 }, unrelated: { n: 900 } },
    );
    expect(result.map((r) => r.result?.state_updates)).toEqual([{ n: 6 }, { n: 21 }, { n: 1 }]);
  });

  it("converts integers to CEL int and preserves USD and fractional JSON as double", async () => {
    const context = policyContext();
    context.tool!.args = { whole: 4, fraction: 0.5, items: [1, 2] };
    const expr = `type(cost.costUsd) == double && type(cost.maxCostUsd) == double &&
      type(cost.tokens) == int && type(cost.maxTokens) == int &&
      type(cost.watermark.settleSeq) == int && type(session.controlRevision) == int &&
      type(tool.args.whole) == int && type(tool.args.fraction) == double &&
      type(tool.args.items[0]) == int && type(counters.n) == int &&
      cost.costUsd >= double(cost.maxCostUsd) * 0.5
      ? dyn({"verdict":"ALLOW","reason":""}) : dyn({"verdict":"DENY","reason":"bad numeric kind"})`;
    expect(
      (await evaluator().evaluateRules([policyRule(expr)], context, { rule: { n: 1 } }))[0].result
        ?.verdict,
    ).toBe("ALLOW");
  });

  it("preserves order and skips disabled and other-phase rules", async () => {
    const rules = [
      policyRule("null", { id: "z" }),
      policyRule("invalid !", { enabled: false }),
      policyRule("bad", { phases: ["request"] }),
      policyRule("null", { id: "a" }),
    ];
    const evaluated = await evaluator().evaluateRules(rules, policyContext(), {});
    expect(evaluated.map((r) => r.ruleId)).toEqual(["z", "rule", "rule", "a"]);
    expect(evaluated.every((r) => r.result === null && r.error === null)).toBe(true);
  });

  it.each([
    ["parse", "{"],
    ["type", "unknown == 1"],
    ["type", '1 + "x"'],
    ["runtime", '{"verdict":"ALLOW","reason":string(tool.args.absent)}'],
    ["runtime", '{"verdict":"ALLOW","reason":"","extra":1}'],
    ["runtime", '{"verdict":"ASK","reason":""}'],
    ["runtime", '{"verdict":"MAYBE","reason":""}'],
    ["runtime", '{"verdict":"ALLOW","reason":"","state_updates":{"n":9007199254740992}}'],
    ["runtime", '{"verdict":"ALLOW","reason":"","state_updates":{"n":0.5}}'],
    ["runtime", '{"verdict":"ALLOW","reason":"","state_updates":{"n":1.0}}'],
    ["runtime", '{"verdict":"ALLOW","reason":"","state_updates":{"n":1u}}'],
    ["type", '{"verdict":"ALLOW","reason":"","state_updates":{"constructor":1}}'],
  ])("keeps %s failures distinct from no-match: %s", async (kind, expression) => {
    const result = (
      await evaluator().evaluateRules([policyRule(expression)], policyContext(), {})
    )[0];
    expect(result.result).toBeNull();
    expect(result.error?.kind).toBe(kind);
    expect(result.result?.state_updates).toBeUndefined();
  });

  it("returns source ranges for parse/type errors without executing validation", async () => {
    const pool = evaluator();
    const invalid = await pool.validateRule(policyRule("unknown"));
    expect(invalid).toMatchObject({
      valid: false,
      error: { kind: "type", range: { start: 0, end: 7 } },
    });
    expect(
      await pool.validateRule(policyRule('{"verdict":"ALLOW","reason":string(tool.args.missing)}')),
    ).toEqual({ valid: true, returnType: "map<string, string>" });
  });

  it.each([
    "x".repeat(8193),
    `[${Array.from({ length: 101 }, () => "0").join(",")}]`,
    `{${Array.from({ length: 101 }, (_, i) => `"k${i}":0`).join(",")}}`,
    `${"!".repeat(45)}true`,
    (() => {
      const tree = (n: number): string =>
        n === 1 ? "1" : `(${tree(Math.floor(n / 2))}+${tree(Math.ceil(n / 2))})`;
      return tree(1100);
    })(),
    `max(${Array.from({ length: 17 }, () => "0").join(",")})`,
  ])("rejects excessive expression structure", async (expression) => {
    expect((await evaluator().validateRule(policyRule(expression))).valid).toBe(false);
  });

  it("rejects non-JSON, unsafe integers, prototype keys, cycles and deep contexts before execution", async () => {
    const cases: unknown[] = [
      NaN,
      Infinity,
      () => 1,
      1n,
      Number.MAX_SAFE_INTEGER + 1,
      new Date(),
      JSON.parse('{"constructor":0}'),
      JSON.parse('{"__proto__":0}'),
    ];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cases.push(cyclic);
    let deep: unknown = 0;
    for (let i = 0; i < 21; i++) deep = { next: deep };
    cases.push(deep);
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    cases.push(accessor);
    for (const value of cases) {
      const context = policyContext();
      context.tool!.args = { value } as never;
      expect((await evaluator().evaluateRules([policyRule()], context, {}))[0]).toMatchObject({
        result: null,
        error: { kind: "limit", range: null },
      });
    }
  });

  it("enforces 64-KiB contexts, depth, 128 enabled rules and a 2-MiB total job", async () => {
    const pool = evaluator();
    const context = policyContext();
    context.tool!.args = { big: "é".repeat(33000) };
    expect((await pool.evaluateRules([policyRule()], context, {}))[0]).toMatchObject({
      result: null,
      error: { kind: "limit", message: "Policy input is too large to evaluate." },
    });
    const tooMany = await pool.evaluateRules(
      Array.from({ length: 129 }, (_, i) => policyRule("null", { id: `r${i}` })),
      policyContext(),
      {},
    );
    expect(tooMany).toHaveLength(129);
    expect(tooMany.every((r) => r.result === null && r.error?.kind === "limit")).toBe(true);
    const rules = Array.from({ length: 300 }, (_, i) =>
      policyRule(" ".repeat(8000), { id: `r${i}`, enabled: false }),
    );
    expect((await pool.evaluateRules(rules, policyContext(), {}))[0]).toMatchObject({
      result: null,
      error: { kind: "limit" },
    });
  });

  it("reports malformed phase context without a matched verdict", async () => {
    const context = { ...policyContext(), request: { method: "inbox.read", args: {} } } as Omit<
      PolicyContext,
      "counters"
    >;
    expect((await evaluator().evaluateRules([policyRule()], context, {}))[0]).toMatchObject({
      result: null,
      error: { kind: "type" },
    });
  });

  it("rejects invalid counters and oversized merged patches", async () => {
    const pool = evaluator();
    const many = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, i]));
    const result = await pool.evaluateRules(
      [policyRule('{"verdict":"ALLOW","reason":"","state_updates":{"new_key":1}}')],
      policyContext(),
      { rule: many },
    );
    expect(result[0]).toMatchObject({ result: null, error: { kind: "runtime" } });
    expect(
      (await pool.evaluateRules([policyRule()], policyContext(), { rule: { bad: 0.5 } }))[0].error
        ?.kind,
    ).toBe("type");
  });

  it.each(["true", "42", '"text"', "[1]"])(
    "rejects non-map root type %s at validation",
    async (expression) => {
      expect(await evaluator().validateRule(policyRule(expression))).toMatchObject({
        valid: false,
        error: { kind: "type", range: null },
      });
    },
  );

  it("does not accept forged rule metadata or overlong expressions", async () => {
    expect(
      await evaluator().validateRule({ ...policyRule(), revision: 0 } as PolicyRule),
    ).toMatchObject({ valid: false, error: { kind: "type" } });
  });

  it("times out CPU-heavy CEL, then successfully evaluates on a recreated worker", async () => {
    const pool = evaluator();
    const context = policyContext();
    context.tool!.args = { values: Array.from({ length: 1000 }, (_, i) => i) };
    const expression = `tool.args.values.all(x, tool.args.values.all(y, tool.args.values.all(z, x+y+z >= 0))) ? dyn({"verdict":"ALLOW","reason":""}) : dyn(null)`;
    expect((await pool.evaluateRules([policyRule(expression)], context, {}))[0]).toMatchObject({
      result: null,
      error: { kind: "timeout", range: null },
    });
    expect(await pool.validateRule(policyRule("null", { id: "after" }))).toEqual({
      valid: true,
      returnType: "null_type",
    });
  });

  it("fails closed after shutdown", async () => {
    const pool = evaluator();
    await pool.close();
    expect(await pool.validateRule(policyRule())).toMatchObject({
      valid: false,
      error: { kind: "worker" },
    });
    expect((await pool.evaluateRules([policyRule()], policyContext(), {}))[0]).toMatchObject({
      result: null,
      error: { kind: "worker", range: null },
    });
  });
});
