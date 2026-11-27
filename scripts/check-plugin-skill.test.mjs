import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateSkill } from "../skills/switchyard-plugin-development/scripts/check.mjs";

const source = resolve("skills/switchyard-plugin-development");
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-check-"));
  try {
    const dir = join(root, "source");
    cpSync(source, dir, { recursive: true });
    fn({ root, dir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function replace(path, from, to) {
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}
function lock(hash) {
  return {
    version: 1,
    skills: {
      "switchyard-plugin-development": {
        source: "justmytwospence/switchyard",
        sourceType: "github",
        ref: "a".repeat(40),
        skillPath: "skills/switchyard-plugin-development/SKILL.md",
        computedHash: hash,
      },
    },
  };
}

test("valid bundle, pinned lock and mirror", () =>
  fixture(({ root, dir }) => {
    const { name, hash, files } = validateSkill(dir);
    assert.equal(name, "switchyard-plugin-development");
    assert.equal(files.length, 4);
    const mirror = join(root, "mirror"),
      lockFile = join(root, "lock.json");
    cpSync(dir, mirror, { recursive: true });
    writeFileSync(lockFile, JSON.stringify(lock(hash)));
    assert.equal(validateSkill(dir, { mirrorDir: mirror, lockFile }).hash, hash);
  }));

test("metadata, references and links are validated", () => {
  for (const [from, to, error] of [
    ["name: switchyard-plugin-development", "name: wrong", /name/],
    ["name: switchyard-plugin-development", "other: x", /name/],
    [/description: [^\n]*/, "description: ", /description/],
    [/description: [^\n]*/, "other: missing", /description/],
    [/description: [^\n]*/, `description: ${"x".repeat(1025)}`, /description/],
    ["references/authoring.md", "references/missing.md", /missing link/],
    ["references/authoring.md", "../../outside.md", /escaping link/],
    ["references/authoring.md", "/tmp/outside.md", /invalid link/],
  ])
    fixture(({ dir }) => {
      const file = join(dir, "SKILL.md");
      replace(file, from, to);
      assert.throws(() => validateSkill(dir), error);
    });
  fixture(({ dir }) => {
    rmSync(join(dir, "references/authoring.md"));
    assert.throws(() => validateSkill(dir), /required file/);
  });
});

test("reject symlinks and mismatched mirrors", () => {
  fixture(({ dir }) => {
    symlinkSync("SKILL.md", join(dir, "link"));
    assert.throws(() => validateSkill(dir), /symlink/);
  });
  for (const mode of ["symlink", "missing", "extra", "mutated"])
    fixture(({ root, dir }) => {
      const mirror = join(root, "mirror");
      cpSync(dir, mirror, { recursive: true });
      if (mode === "symlink") symlinkSync("SKILL.md", join(mirror, "link"));
      if (mode === "missing") rmSync(join(mirror, "SKILL.md"));
      if (mode === "extra") writeFileSync(join(mirror, "extra"), "x");
      if (mode === "mutated") writeFileSync(join(mirror, "SKILL.md"), "x");
      assert.throws(() => validateSkill(dir, { mirrorDir: mirror }), /symlink|differs/);
    });
});

test("lock fields and content integrity", () =>
  fixture(({ root, dir }) => {
    const lockFile = join(root, "lock.json"),
      valid = lock(validateSkill(dir).hash);
    for (const key of ["source", "sourceType", "ref", "skillPath", "computedHash"]) {
      const bad = structuredClone(valid);
      bad.skills["switchyard-plugin-development"][key] = "bad";
      writeFileSync(lockFile, JSON.stringify(bad));
      assert.throws(() => validateSkill(dir, { lockFile }), new RegExp(key));
    }
    writeFileSync(lockFile, JSON.stringify({ ...valid, version: 2 }));
    assert.throws(() => validateSkill(dir, { lockFile }), /version/);
    writeFileSync(lockFile, JSON.stringify({ version: 1, skills: {} }));
    assert.throws(() => validateSkill(dir, { lockFile }), /missing skill/);
    writeFileSync(lockFile, JSON.stringify(valid));
    writeFileSync(join(dir, "extra"), "changed");
    assert.throws(() => validateSkill(dir, { lockFile }), /computedHash/);
  }));

test("hash is independent of file creation order", () =>
  fixture(({ root, dir }) => {
    const other = join(root, "other");
    mkdirSync(other);
    const files = validateSkill(dir).files;
    for (const file of [...files].reverse()) {
      mkdirSync(join(other, file, ".."), { recursive: true });
      writeFileSync(join(other, file), readFileSync(join(dir, file)));
    }
    assert.equal(validateSkill(other).hash, validateSkill(dir).hash);
  }));
