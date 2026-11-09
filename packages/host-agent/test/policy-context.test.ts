// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Shell expansions must remain inert literal test input.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyToolSafety,
  collectToolPolicyContext,
  resolvePolicyBoundary,
} from "../src/policy-context.js";

describe("tool safety classification", () => {
  let base: string;
  let root: string;
  const classify = (command: string, branch: string | null = "main") =>
    classifyToolSafety("bash", { command }, root, root, branch);
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "switchyard-policy-"));
    root = path.join(base, "workspace");
    mkdirSync(root);
    mkdirSync(path.join(root, "child"));
    mkdirSync(path.join(base, "outside"));
    symlinkSync(path.join(base, "outside"), path.join(root, "link"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("ignores unrelated tools and ordinary pipelines", () => {
    expect(classifyToolSafety("read", { command: "rm -rf /" }, root, root, "main").uncertain).toBe(
      false,
    );
    expect(classify("echo hello | grep hello")).toEqual({
      destructiveDelete: false,
      forcePush: false,
      defaultBranchPush: false,
      uncertain: false,
      reasons: [],
    });
  });
  it("resolves missing targets and symlinks across workspace boundaries", () => {
    expect(classify("rm -rf child/missing").destructiveDelete).toBe(false);
    expect(classify("rm -rf ../workspace-other/missing").destructiveDelete).toBe(true);
    expect(classify("rm --recursive --force link/missing").destructiveDelete).toBe(true);
    expect(classify("rm -Rf -- ../outside").destructiveDelete).toBe(true);
    expect(classify("rm -r ../outside").destructiveDelete).toBe(false);
  });
  it("traverses symlinks before parent components for existing and missing targets", () => {
    // Lexical collapse puts both targets inside root; actual traversal leaves it.
    expect(classify("rm -rf link/../outside").destructiveDelete).toBe(true);
    expect(classify("rm -rf link/../outside/missing").destructiveDelete).toBe(true);
    expect(classify(`rm -rf ${root}/link/../outside/missing`).destructiveDelete).toBe(true);
    expect(classify("cd link/.. && rm -rf outside").destructiveDelete).toBe(true);
    expect(classify("rm -rf missing/../child").uncertain).toBe(true);
    symlinkSync(path.join(base, "absent"), path.join(root, "dangling"));
    expect(classify("rm -rf dangling/../child").uncertain).toBe(true);
    // Literal parent traversal and nearest-existing-parent inference still work.
    expect(classify("rm -rf child/../child/missing")).toMatchObject({
      destructiveDelete: false,
      uncertain: false,
    });
  });
  it.each([
    "cd missing || rm -rf ../outside",
    "cd missing && rm -rf ../outside",
    "cd child || rm -rf ../outside",
    "cd child; rm -rf ../outside",
    "false && cd child; rm -rf ../outside",
  ])("does not prove a cwd from a failed or conditional cd: %s", (command) => {
    expect(classify(command).uncertain).toBe(true);
  });
  it("does not let shell-quote's mid-word comment handling hide deletion operands", () => {
    mkdirSync(path.join(root, "child#keep"));
    expect(classify("rm -rf child#keep ../outside").uncertain).toBe(true);
    expect(classify("echo child#keep").uncertain).toBe(false);
  });
  it.each([
    "rm -rf {child,../outside}",
    "rm -rf [n]ode_modules/...",
    "rm -rf [n]ode_modules/missing",
  ])("marks expansions shell-quote leaves as literal words unresolved: %s", (command) => {
    symlinkSync(path.join(base, "outside"), path.join(root, "node_modules"));
    expect(classify(command).uncertain).toBe(true);
  });
  it.each([
    "git push --force${EMPTY} origin topic:topic",
    "git push --${MODE} origin topic:topic",
    "git push -${FLAGS} origin topic:topic",
    "git push --receive-pack ${PROGRAM} origin topic:topic",
  ])("does not discard unknown git push options: %s", (command) => {
    expect(classify(command).uncertain).toBe(true);
  });
  it("invalidates the original default-branch proof when git selects another repository", () => {
    const other = path.join(base, "outside");
    // Only fixed read/write Git fixture setup, never execution of the classified text.
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    execFileSync("git", ["init", "--quiet", other]);
    execFileSync("git", [
      "-C",
      other,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);
    for (const command of [
      "git -C ../outside push origin trunk",
      "git -C../outside push origin trunk",
      "git --git-dir ../outside/.git push origin trunk",
      "git --git-dir=../outside/.git push origin trunk",
      "git --work-tree=../outside push origin trunk",
      "cd ../outside && git push origin trunk",
    ]) {
      expect(classify(command), command).toMatchObject({
        defaultBranchPush: false,
        uncertain: true,
      });
    }
    expect(classify("git -C ../outside push origin main")).toMatchObject({
      defaultBranchPush: false,
      uncertain: true,
    });
  });
  it.each([
    "env -u UNUSED rm -rf /outside",
    "env --unset UNUSED rm -rf /outside",
    "sudo --chdir=/ rm -rf child",
    "sudo --chdir / rm -rf child",
    "sudo -D / rm -rf child",
    "env -C / rm -rf child",
    "/bin/rm -rf /outside",
    ">/dev/null rm -rf /outside",
    "2>/dev/null /bin/rm -rf /outside",
  ])("cannot hide a destructive candidate behind wrappers or redirection: %s", (command) => {
    const safety = classify(command);
    expect(safety.destructiveDelete || safety.uncertain, command).toBe(true);
  });
  it("keeps regression samples inert through the D.3 shared collection helper", async () => {
    const sentinel = path.join(base, "must-not-exist");
    const keep = path.join(base, "outside", "keep");
    writeFileSync(keep, "untouched");
    const boundary = await resolvePolicyBoundary(root, root);
    for (const command of [
      "rm -rf link/../outside",
      "cd missing || rm -rf ../outside",
      "rm -rf child#keep ../outside",
      "rm -rf {child,../outside}",
      "rm -rf [n]ode_modules/...",
      "git push --force${EMPTY} origin topic:topic",
      "git push --${MODE} origin topic:topic",
      "git -C ../outside push origin trunk",
      "git --git-dir=../outside/.git push origin trunk",
      "env -u UNUSED rm -rf /outside",
      "sudo --chdir=/ rm -rf child",
      "/bin/rm -rf /outside",
      ">/dev/null rm -rf /outside",
      `touch ${sentinel}; rm -rf ../outside`,
    ]) {
      const tool = { name: "bash", args: { command } };
      const sample = await collectToolPolicyContext(tool, {
        verifyBoundary: async () => boundary,
        check: () => {},
      });
      expect(sample.safety).toEqual(
        classifyToolSafety(
          "bash",
          tool.args,
          boundary.cwdReal,
          boundary.workspaceRootReal,
          sample.defaultBranch,
        ),
      );
      const safety = sample.safety;
      expect(
        safety.destructiveDelete ||
          safety.forcePush ||
          safety.defaultBranchPush ||
          safety.uncertain,
        command,
      ).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(keep, "utf8")).toBe("untouched");
    }
  });
  it("tracks cd, git -C and wrappers", () => {
    expect(
      classify("cd child && sudo -u root env X=1 command rm -fr ../../outside").destructiveDelete,
    ).toBe(true);
    expect(classify("cd $DIR && rm -rf child").uncertain).toBe(true);
    expect(classify("git -C child push origin HEAD:refs/heads/main")).toMatchObject({
      defaultBranchPush: false,
      uncertain: true,
    });
    expect(classify("git -C $DIR push origin topic:topic").uncertain).toBe(true);
  });
  it("marks unknown deletion candidates rather than treating expansions as empty", () => {
    for (const command of [
      "rm -rf $TARGET",
      "rm -rf *.tmp",
      "rm -rf $(pwd)",
      "rm -rf `pwd`",
      "rm -rf ~/tmp",
      "rm -rf x <<EOF",
    ]) {
      expect(classify(command).uncertain, command).toBe(true);
    }
    expect(classify("echo $TARGET | grep x").uncertain).toBe(false);
    expect(classify("echo ok\nrm -rf ../outside").uncertain).toBe(true);
    expect(classify("echo ok\ngit status").uncertain).toBe(false);
    expect(classify("cd child | rm -rf ../../outside").uncertain).toBe(true);
  });
  it("recognizes force and default branch pushes and unresolved destinations", () => {
    expect(classify("git push -f origin topic").forcePush).toBe(true);
    expect(classify("git push --force-with-lease=main:abc origin topic").forcePush).toBe(true);
    expect(classify("git push origin +topic:main")).toMatchObject({
      forcePush: true,
      defaultBranchPush: true,
    });
    expect(classify("git push origin topic:other")).toMatchObject({
      forcePush: false,
      defaultBranchPush: false,
      uncertain: false,
    });
    expect(classify("git push").uncertain).toBe(true);
    expect(classify("git push origin HEAD").uncertain).toBe(true);
    expect(classify("git push origin topic", null).uncertain).toBe(true);
    expect(classify("git push origin $BRANCH").uncertain).toBe(true);
  });
});
