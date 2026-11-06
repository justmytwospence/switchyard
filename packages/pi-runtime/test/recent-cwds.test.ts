import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRecentSessionCwds } from "../src/importable.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root() {
  const d = mkdtempSync(join(tmpdir(), "sy-cwds-"));
  dirs.push(d);
  return d;
}

function session(dir: string, name: string, header: unknown, ageDays: number) {
  mkdirSync(join(dir, "slug"), { recursive: true });
  const f = join(dir, "slug", `${name}.jsonl`);
  writeFileSync(f, `${JSON.stringify(header)}\n{"type":"message"}\n`);
  const t = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(f, t, t);
}

describe("listRecentSessionCwds", () => {
  it("filters by age and header type", async () => {
    const d = root();
    session(d, "new", { type: "session", id: "1", cwd: "/a" }, 1);
    session(d, "old", { type: "session", id: "2", cwd: "/b" }, 60);
    session(d, "other", { type: "message", cwd: "/c" }, 1);
    session(d, "nocwd", { type: "session", id: "4" }, 1);
    const out = await listRecentSessionCwds(d, Date.now() - 30 * 86_400_000);
    expect(out.map((o) => o.cwd)).toEqual(["/a"]);
  });

  it("returns [] for a missing root", async () => {
    expect(await listRecentSessionCwds("/nonexistent-sy-root", 0)).toEqual([]);
  });
});
