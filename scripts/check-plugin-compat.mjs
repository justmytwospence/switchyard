import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

export function options(args, env = process.env) {
  const flags = args.filter((arg) => arg !== "--");
  for (const arg of flags) {
    if (!["--allow-dirty", "--current-suite"].includes(arg))
      throw new Error(`Unknown flag: ${arg}`);
  }
  const allowDirty = flags.includes("--allow-dirty");
  const currentSuite = flags.includes("--current-suite");
  if (env.CI && env.CI !== "false" && allowDirty)
    throw new Error("--allow-dirty is local-only; CI refuses it");
  if ((allowDirty || currentSuite) && !env.SWITCHYARD_PI_PLUGINS_DIR) {
    throw new Error("Development flags require explicit SWITCHYARD_PI_PLUGINS_DIR");
  }
  if (env.SWITCHYARD_SKIP_REAL_PI === "1")
    throw new Error("Required plugin compatibility cannot skip real Pi");
  return { allowDirty, currentSuite };
}

export function checkout(path) {
  const dir = realpathSync(path);
  if (realpathSync(git(dir, "rev-parse", "--show-toplevel")) !== dir) {
    throw new Error(`Expected a repository root, not a nested directory: ${dir}`);
  }
  return {
    dir,
    commit: git(dir, "rev-parse", "HEAD"),
    version: json(resolve(dir, "package.json")).version,
    dirty: git(dir, "status", "--porcelain", "--untracked-files=normal") !== "",
  };
}

export function validatePair(core, suite, pin, opts) {
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || typeof pin.version !== "string") {
    throw new Error("Compatibility pin must contain an immutable commit and version");
  }
  if (!opts.allowDirty && (core.dirty || suite.dirty)) {
    throw new Error(
      "Compatibility requires clean Switchyard and suite checkouts (local development: --allow-dirty)",
    );
  }
  if (
    !opts.currentSuite &&
    !opts.allowDirty &&
    (suite.commit !== pin.commit || suite.version !== pin.version)
  ) {
    throw new Error(
      `Suite does not match pin ${pin.commit} (${pin.version}); use --current-suite for a clean reverse check`,
    );
  }
}

export function main(args = process.argv.slice(2), env = process.env) {
  const opts = options(args, env);
  const pin = json(resolve(root, ".github/compat-pi-plugins.json"));
  // No moving refs or implicit installs: the default sibling must be at the recorded pin.
  // CI checks that commit out in RUNNER_TEMP and supplies its absolute directory.
  const suite = checkout(env.SWITCHYARD_PI_PLUGINS_DIR || resolve(root, "../pi-plugins"));
  const core = checkout(root);
  validatePair(core, suite, pin, opts);
  realpathSync(resolve(root, "packages/adapter-sdk/dist/index.js"));
  realpathSync(resolve(root, "packages/host-agent/dist/index.js"));
  const piBin = env.SWITCHYARD_PI_BIN || "pi";
  const childEnv = {
    ...env,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    SWITCHYARD_REQUIRE_PI_PLUGINS: "1",
    SWITCHYARD_PI_PLUGINS_DIR: suite.dir,
    SWITCHYARD_SKIP_REAL_PI: "0",
  };
  for (const key of [
    "TYPESAFE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
  ])
    childEnv[key] = "";
  const piVersion = execFileSync(piBin, ["--version"], {
    encoding: "utf8",
    timeout: 30000,
    env: childEnv,
  }).trim();
  console.log(
    JSON.stringify(
      {
        switchyard: core,
        suite,
        piBin,
        piVersion,
        transports: ["rpc", "terminal"],
        mode: opts.currentSuite
          ? "current-suite"
          : opts.allowDirty
            ? "local-development"
            : "pinned",
        allowDirty: opts.allowDirty,
      },
      null,
      2,
    ),
  );
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "packages/host-agent/test/compat"], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Plugin compatibility: ${error.message}`);
    process.exitCode = 1;
  }
}
