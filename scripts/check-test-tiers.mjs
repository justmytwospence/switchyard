// Fails when a test file that starts a coordinator, Pi, a mock model, a child process, a worker or
// a server lacks `// @module-tag slow`, so `pnpm test:fast` stays fast (docs/development.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLOW_USE =
  /startCoordinator|setupHarness|startHarness|Integration\.create|IntegrationHarness|requirePi|makePiEnv|startMockModel|child_process|spawn\(|execFile|makeRepo|new PolicyEvaluator|createCoordinator|runHostAgent|new Worker|listen\(/;

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.test\.tsx?$/.test(entry) && path.includes("/test/")) files.push(path);
  }
}
for (const pkg of readdirSync(join(root, "packages"))) {
  const dir = join(root, "packages", pkg);
  if (statSync(dir).isDirectory()) walk(dir);
}

let slow = 0;
const flagged = [];
for (const file of files.sort()) {
  const source = readFileSync(file, "utf8");
  const tagged = source.split("\n", 5).some((line) => line.includes("@module-tag slow"));
  if (tagged) slow++;
  else if (file.includes("/test/compat/") || SLOW_USE.test(source))
    flagged.push(relative(root, file));
}

if (flagged.length > 0) {
  console.error(
    'check-test-tiers: these test files start processes, coordinators, Pi or servers; add "// @module-tag slow" as their first line:',
  );
  for (const file of flagged) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`check-test-tiers: ${files.length - slow} fast, ${slow} slow`);
