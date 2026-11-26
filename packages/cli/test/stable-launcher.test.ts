import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStableLauncher } from "../src/herdr/util.js";
import { writeStableTmuxLauncher } from "../src/tmux/util.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A Homebrew-like prefix: `<root>/bin/node` beside `<root>/Cellar/node/<v>/bin/node`. */
function prefix(): { execPath: string; bin: string } {
  root = mkdtempSync(join(tmpdir(), "sy-launcher-"));
  const bin = join(root, "bin");
  const cellar = join(root, "Cellar", "node", "26.13.1_4", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(cellar, { recursive: true });
  writeFileSync(join(bin, "node"), "");
  writeFileSync(join(cellar, "node"), "");
  return { execPath: join(cellar, "node"), bin };
}

describe("stable launchers", () => {
  it("herdr: puts the prefix's bin on PATH, not Homebrew's versioned Cellar directory", () => {
    const { execPath, bin } = prefix();
    const path = writeStableLauncher(join(root!, "state"), "/plugin", execPath);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`PATH='${bin}':"$PATH"`);
    expect(text).not.toContain("Cellar");
    expect(text).toContain("exec sh '/plugin/switchyard-herdr.sh'");
  });

  it("tmux: the same", () => {
    const { execPath, bin } = prefix();
    const text = readFileSync(
      writeStableTmuxLauncher(join(root!, "state"), "/plugin", execPath),
      "utf8",
    );
    expect(text).toContain(`PATH='${bin}':"$PATH"`);
    expect(text).not.toContain("Cellar");
  });

  it("keeps a node directory that is not Homebrew's", () => {
    root = mkdtempSync(join(tmpdir(), "sy-launcher-"));
    const text = readFileSync(
      writeStableLauncher(join(root, "state"), "/plugin", "/usr/local/n/bin/node"),
      "utf8",
    );
    expect(text).toContain(`PATH='/usr/local/n/bin':"$PATH"`);
  });
});
