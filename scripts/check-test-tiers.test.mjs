import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { memberships, validateInventory, validateSelectors } from "./check-test-tiers.mjs";

const files = [
  { project: "a", path: "packages/a/test/fast.test.ts", source: "" },
  { project: "a", path: "packages/a/test/slow.test.ts", source: "// @module-tag slow\nspawn()" },
  {
    project: "host-agent",
    path: "packages/host-agent/test/compat/pinned.test.ts",
    source: "// @module-tag slow\n// @module-tag compat",
  },
];
const configured = files.map(({ project, path }) => ({ project, path }));
const errors = (input = files, specs = configured, select) =>
  validateInventory(input, specs, select).errors.join("\n");

test("valid tiers form a disjoint union", () => {
  assert.deepEqual(validateInventory(files, configured), {
    errors: [],
    lanes: { fast: 1, slow: 1, compat: 1 },
  });
});
test("overlapping or missing membership fails", () => {
  assert.match(
    errors(files, configured, (file) => ({ ...memberships(file), fast: true })),
    /exactly one lane/,
  );
  assert.match(
    errors(files, configured, (file) => ({ ...memberships(file), slow: false })),
    /exactly one lane|empty lane/,
  );
});
test("compat tag and pinned path must agree", () => {
  assert.match(
    errors([{ ...files[0], source: "// @module-tag compat" }, ...files.slice(1)]),
    /compat tag/,
  );
  assert.match(
    errors([...files.slice(0, 2), { ...files[2], source: "// @module-tag slow" }]),
    /compat tag/,
  );
});
test("heavy tests require slow", () => {
  assert.match(errors([{ ...files[0], source: "spawn()" }, ...files.slice(1)]), /missing slow tag/);
});
test("inventory mismatch and duplicates fail", () => {
  assert.match(errors(files, configured.slice(1)), /missing from Vitest/);
  assert.match(errors(files.slice(1), configured), /missing from scanner/);
  assert.match(errors(files, [...configured, configured[0]]), /duplicate configured/);
  assert.match(errors([...files, files[0]]), /duplicate scanned/);
});
test("script and workflow selector drift fails", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).scripts;
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./check-plugin-compat.mjs", import.meta.url), "utf8");
  assert.deepEqual(validateSelectors(scripts, workflow, runner), []);
  assert.match(
    validateSelectors({ ...scripts, "test:slow": "vitest run" }, workflow, runner).join(),
    /slow selector/,
  );
  assert.match(
    validateSelectors(
      scripts,
      workflow.replace("pnpm test:slow --shard", "pnpm test --shard"),
      runner,
    ).join(),
    /shard workflow/,
  );
  assert.match(
    validateSelectors(
      scripts,
      workflow,
      runner.replace("packages/host-agent/test/compat", "packages/host-agent/test"),
    ).join(),
    /pinned runner/,
  );
});
