import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnrollMeta } from "@switchyard/pi-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSessionWatcher } from "../src/external-sessions.js";
import { silentLogger } from "../src/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sy-ext-w-"));
  mkdirSync(join(dir, "runtime"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function enrol(name: string, meta: Partial<EnrollMeta> | null) {
  const sock = join(dir, "runtime", name);
  writeFileSync(sock, "");
  if (meta)
    writeFileSync(
      `${sock}.json`,
      JSON.stringify({
        pid: process.pid,
        cwd: "/repo",
        client: "herdr:default@mac",
        sessionId: "s1",
        sessionFile: "/s1.jsonl",
        startedAt: "2026-01-01T00:00:00.000Z",
        ...meta,
      }),
    );
  return sock;
}

function watcher(inUse = new Set<string>()) {
  const supervisor = {
    usesSocket: vi.fn((p: string) => inUse.has(p)),
    adoptExternal: vi.fn(async (p: string) => {
      inUse.add(p);
      return "adopted" as const;
    }),
  };
  const w = new ExternalSessionWatcher({
    supervisor,
    runtimeDir: join(dir, "runtime"),
    log: silentLogger(),
  });
  return { w, supervisor };
}

describe("ExternalSessionWatcher", () => {
  it("adopts an enrolled Pi once", async () => {
    const sock = enrol("ext-0000abcd.sock", {});
    const { w, supervisor } = watcher();
    await w.scan();
    await w.scan();
    expect(supervisor.adoptExternal).toHaveBeenCalledExactlyOnceWith(
      sock,
      expect.objectContaining({ pid: process.pid, sessionFile: "/s1.jsonl" }),
    );
  });

  it("ignores holder sockets and other files", async () => {
    enrol("term-0000abcd.sock", {});
    enrol("ext-nothex!.sock", {});
    const { w, supervisor } = watcher();
    await w.scan();
    expect(supervisor.adoptExternal).not.toHaveBeenCalled();
  });

  it("removes the socket of a Pi that is gone, and stale sockets without meta", async () => {
    const dead = enrol("ext-0000dead.sock", { pid: 2 ** 22 + 12345 });
    const bare = enrol("ext-0000beef.sock", null);
    const fresh = enrol("ext-0000f00d.sock", null);
    const old = new Date(Date.now() - 120_000);
    utimesSync(bare, old, old);
    const { w, supervisor } = watcher();
    await w.scan();
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(`${dead}.json`)).toBe(false);
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(supervisor.adoptExternal).not.toHaveBeenCalled();
  });
});
