// Validate the disjoint CI partitions without importing test modules.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLOW_USE =
  /startCoordinator|setupHarness|startHarness|Integration\.create|IntegrationHarness|requirePi|makePiEnv|startMockModel|child_process|spawn\(|execFile|makeRepo|new PolicyEvaluator|createCoordinator|runHostAgent|new Worker|listen\(/;
export const compatPath = "packages/host-agent/test/compat/";
const identity = ({ project, path }) => `${project}:${path}`;

export function scanInventory(base = root) {
  const files = [];
  function walk(dir, project) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) walk(file, project);
      else if (/\.test\.tsx?$/.test(entry) && file.includes("/test/")) {
        files.push({
          project,
          path: relative(base, file).replaceAll("\\", "/"),
          source: readFileSync(file, "utf8"),
        });
      }
    }
  }
  for (const project of readdirSync(join(base, "packages"))) {
    const dir = join(base, "packages", project);
    if (statSync(dir).isDirectory()) walk(dir, project);
  }
  return files;
}

// Same module-tag regexp as Vitest's detectCodeBlock, including tags anywhere in the file.
export function moduleTags(source) {
  return new Set(
    Array.from(source.matchAll(/(?:\/\/|\*)\s*@module-tag\s+([\w\-/]+)\b/g), (match) => match[1]),
  );
}

export function memberships(file) {
  const tags = moduleTags(file.source);
  return {
    fast: !tags.has("slow"),
    slow: tags.has("slow") && !tags.has("compat"),
    compat: file.path.startsWith(compatPath),
  };
}

export function validateInventory(files, configured, select = memberships) {
  const errors = [];
  const lanes = { fast: 0, slow: 0, compat: 0 };
  const scanned = new Set();
  const specs = new Set();
  for (const file of files) {
    const key = identity(file);
    if (scanned.has(key)) errors.push(`duplicate scanned test: ${key}`);
    scanned.add(key);
    const tags = moduleTags(file.source);
    const pinned = file.path.startsWith(compatPath);
    if (pinned !== tags.has("compat")) errors.push(`${key}: compat tag must match pinned path`);
    if (!tags.has("slow") && (pinned || SLOW_USE.test(file.source)))
      errors.push(`${key}: missing slow tag`);
    const selected = Object.keys(lanes).filter((lane) => select(file)[lane]);
    if (selected.length !== 1)
      errors.push(`${key}: expected exactly one lane, found ${selected.join(", ") || "none"}`);
    for (const lane of selected) lanes[lane]++;
  }
  for (const spec of configured) {
    const key = identity(spec);
    if (specs.has(key)) errors.push(`duplicate configured test: ${key}`);
    specs.add(key);
    if (!scanned.has(key)) errors.push(`configured test missing from scanner: ${key}`);
  }
  for (const key of scanned)
    if (!specs.has(key)) errors.push(`scanned test missing from Vitest: ${key}`);
  for (const [lane, count] of Object.entries(lanes)) if (!count) errors.push(`empty lane: ${lane}`);
  return { errors, lanes };
}

export function validateSelectors(scripts, workflow, runner) {
  const errors = [];
  if (scripts.test !== "vitest run") errors.push("test script must remain unfiltered");
  if (scripts["test:fast"] !== "vitest run --tags-filter=!slow") errors.push("fast selector drift");
  if (scripts["test:plugins"] !== "node scripts/check-plugin-compat.mjs")
    errors.push("pinned script drift");
  if (scripts["test:slow"] !== "vitest run --tags-filter='slow && !compat'")
    errors.push("slow selector drift");
  if (
    scripts["test:tiers"] !==
    "node --test scripts/check-test-tiers.test.mjs && node scripts/check-test-tiers.mjs"
  )
    errors.push("tier checks not enforced");
  const testJob =
    workflow.match(/^ {2}test:\s*\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/m)?.[1] ?? "";
  if (
    !/^\s*shard: \[1, 2, 3, 4, 5\]$/m.test(testJob) ||
    !/^\s*- run: pnpm test:slow --shard=\$\{\{ matrix\.shard \}\}\/5 --reporter=default --reporter=hanging-process$/m.test(
      testJob,
    )
  )
    errors.push("shard workflow selector drift");
  if (
    !/spawnSync\("pnpm", \["exec", "vitest", "run", "packages\/host-agent\/test\/compat"\]/.test(
      runner,
    )
  )
    errors.push("pinned runner selector drift");
  const checkJob =
    workflow.match(/^ {2}check:\s*\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/m)?.[1] ?? "";
  if (
    !/^\s*- run: pnpm test:fast$/m.test(checkJob) ||
    !/^\s*- run: pnpm test:tiers$/m.test(checkJob)
  )
    errors.push("fast workflow selector drift");
  const compatJob =
    workflow.match(/^ {2}plugin-compat:\s*\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/m)?.[1] ?? "";
  if (!/^\s*- run: pnpm test:plugins$/m.test(compatJob))
    errors.push("pinned workflow selector drift");
  return errors;
}

export async function configuredInventory(base = root) {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", { root: base, watch: false });
  if (!vitest) throw new Error("Vitest failed to initialize");
  try {
    return (await vitest.globTestSpecifications()).map((spec) => ({
      project: spec.project.name,
      path: relative(base, spec.moduleId).replaceAll("\\", "/"),
    }));
  } finally {
    await vitest.close();
  }
}

export async function main() {
  const files = scanInventory();
  const result = validateInventory(files, await configuredInventory());
  result.errors.push(
    ...validateSelectors(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts,
      readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
      readFileSync(join(root, "scripts/check-plugin-compat.mjs"), "utf8"),
    ),
  );
  if (result.errors.length) throw new Error(result.errors.join("\n  "));
  console.log(
    `check-test-tiers: ${result.lanes.fast} fast, ${result.lanes.slow} core slow, ${result.lanes.compat} plugin compatibility`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`check-test-tiers: ${error.message}`);
    process.exitCode = 1;
  });
}
