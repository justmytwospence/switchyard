import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkout, options, validatePair } from "./check-plugin-compat.mjs";

const pin = { commit: "a".repeat(40), version: "0.1.75" };
const core = { commit: "b".repeat(40), version: "0.13.0", dirty: false };
const suite = { ...pin, dirty: false };
const pinned = { allowDirty: false, currentSuite: false };

test("default and CI pinned checks require the exact clean counterpart", () => {
  validatePair(core, suite, pin, pinned);
  assert.throws(
    () => validatePair(core, { ...suite, commit: "c".repeat(40) }, pin, pinned),
    /does not match pin/,
  );
  assert.throws(
    () => validatePair(core, { ...suite, version: "0.1.76" }, pin, pinned),
    /does not match pin/,
  );
  assert.throws(() => validatePair({ ...core, dirty: true }, suite, pin, pinned), /requires clean/);
  assert.throws(() => validatePair(core, { ...suite, dirty: true }, pin, pinned), /requires clean/);
  assert.throws(() => validatePair(core, suite, { ...pin, commit: "main" }, pinned), /immutable/);
});

test("reverse current-suite CI accepts clean newer suite without circular pin equality", () => {
  const opts = options(["--current-suite"], { CI: "true", SWITCHYARD_PI_PLUGINS_DIR: "/suite" });
  validatePair(core, { ...suite, commit: "c".repeat(40), version: "0.1.76" }, pin, opts);
  assert.throws(() => validatePair(core, { ...suite, dirty: true }, pin, opts), /requires clean/);
});

test("dirty and mismatched development inputs are explicit and local-only", () => {
  const opts = options(["--", "--allow-dirty"], { SWITCHYARD_PI_PLUGINS_DIR: "/suite" });
  validatePair({ ...core, dirty: true }, { ...suite, dirty: true, version: "dev" }, pin, opts);
  assert.throws(
    () => options(["--allow-dirty"], { CI: "true", SWITCHYARD_PI_PLUGINS_DIR: "/suite" }),
    /local-only/,
  );
  assert.throws(
    () =>
      options(["--current-suite", "--allow-dirty"], {
        CI: "1",
        SWITCHYARD_PI_PLUGINS_DIR: "/suite",
      }),
    /local-only/,
  );
  assert.throws(() => options(["--allow-dirty"], {}), /explicit/);
  assert.throws(() => options(["--current-suite"], {}), /explicit/);
  assert.throws(() => options(["--unknown"], {}), /Unknown flag/);
  assert.throws(() => options([], { SWITCHYARD_SKIP_REAL_PI: "1" }), /cannot skip/);
});

test("checkout reports real root, version, commit and untracked dirty state", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sy-compat-script-")));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  try {
    git("init");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    git("add", "package.json");
    git(
      "-c",
      "user.name=Compat test",
      "-c",
      "user.email=compat@example.invalid",
      "commit",
      "-m",
      "test: create compatibility fixture",
    );
    const actual = checkout(dir);
    assert.equal(actual.dir, dir);
    assert.equal(actual.version, "1.2.3");
    assert.match(actual.commit, /^[a-f0-9]{40}$/);
    assert.equal(actual.dirty, false);
    writeFileSync(join(dir, "untracked"), "changed");
    assert.equal(checkout(dir).dirty, true);
    mkdirSync(join(dir, "nested"));
    assert.throws(() => checkout(join(dir, "nested")), /nested directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
