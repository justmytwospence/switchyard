import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPrivateDir, fallbackSocketDir, shortSocketPath } from "../src/rpc-process.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

function fakeStat(over: { uid?: number; mode?: number }) {
  return {
    uid: over.uid ?? 0,
    mode: over.mode ?? 0o40700,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

describe("socket directories", () => {
  it("tightens a looser directory it owns", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-sock-"));
    cleanup.push(dir);
    chmodSync(dir, 0o755);
    shortSocketPath(dir, "x");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlinked socket directory", () => {
    const real = mkdtempSync(join(tmpdir(), "sw-sock-"));
    const link = join(mkdtempSync(join(tmpdir(), "sw-sock-")), "link");
    cleanup.push(real, dirname(link));
    symlinkSync(real, link);
    expect(() => shortSocketPath(link, "x")).toThrow(/is a symlink/);
  });

  it("falls back to a private per-runtime-dir directory", () => {
    const a = join(tmpdir(), "x".repeat(60), "a".repeat(60));
    const b = join(tmpdir(), "x".repeat(60), "b".repeat(60));
    const subs = [fallbackSocketDir(a), fallbackSocketDir(b)];
    try {
      const pa = shortSocketPath(a, "term");
      const pb = shortSocketPath(b, "term");
      expect(dirname(pa)).not.toBe(dirname(pb));
      for (const p of [pa, pb]) {
        expect(dirname(dirname(p))).toBe(join("/tmp", `switchyard-${process.getuid?.() ?? "u"}`));
        expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
      }
      expect(subs).toContain(dirname(pa));
    } finally {
      for (const s of subs) rmSync(s, { recursive: true, force: true });
    }
  });

  it("checkPrivateDir rejects another user's directory", () => {
    expect(() => checkPrivateDir("/x", fakeStat({ uid: 1 }), 2)).toThrow(/belongs to uid 1, not 2/);
    expect(checkPrivateDir("/x", fakeStat({ uid: 2, mode: 0o40755 }), 2)).toBe("chmod");
  });
});
