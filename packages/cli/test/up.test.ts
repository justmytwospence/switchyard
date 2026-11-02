import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openBrowser, startStandalone } from "../src/commands/up.js";
import { readEndpoint } from "../src/config.js";
import { testCtx } from "./helpers.js";

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("switchyard up (standalone)", () => {
  it("starts the coordinator, auto-enrolls the local host once, and reuses it on restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sy-up-"));
    const ctx = testCtx((i, init) => fetch(i, init));
    const flags = {
      port: "0",
      host: "127.0.0.1",
      dataDir,
      name: "test-host",
      webDist: "/nonexistent",
    };

    const opened: string[] = [];
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = false as never;
    let first: Awaited<ReturnType<typeof startStandalone>>;
    try {
      first = await startStandalone(ctx, flags, { open: (u) => opened.push(u) });
    } finally {
      process.stdout.isTTY = tty;
    }
    try {
      // First start sets the server up and prints a sign-in link; no browser when not a TTY.
      expect(first.firstLink).toMatch(/^http:\/\/localhost:\d+\/enroll#token=/);
      expect(first.coordinator.owner.isInitialized()).toBe(true);
      expect(opened).toEqual([]);
      expect(ctx.lines[0]).toMatch(/^Switchyard is set up\. Open this single-use link/);
      expect(ctx.lines).toContain(`  ${first.firstLink}`);
      const res = await fetch(`${first.localUrl}/healthz`);
      expect(await res.json()).toEqual({ ok: true });
      expect(readEndpoint(dataDir)?.localUrl).toBe(first.localUrl);
      expect(existsSync(join(dataDir, "host", "host.json"))).toBe(true);
      await until(
        () => first.coordinator.store.hosts.get(first.host.hostId)?.connectivity === "connected",
      );
      expect(ctx.errors.some((l) => l.includes('Enrolled the local host "test-host"'))).toBe(true);
    } finally {
      await first.stop();
    }

    const lines = ctx.lines.length;
    const second = await startStandalone(
      ctx,
      { ...flags, open: true },
      {
        open: (u) => opened.push(u),
      },
    );
    try {
      // Already set up: no new link, nothing opened.
      expect(second.firstLink).toBeNull();
      expect(opened).toEqual([]);
      expect(ctx.lines.slice(lines).some((l) => l.includes("/enroll#token="))).toBe(false);
      expect(second.host.hostId).toBe(first.host.hostId);
      expect(second.coordinator.store.hosts.list().filter((h) => !h.revokedAt)).toHaveLength(1);
      await until(
        () => second.coordinator.store.hosts.get(second.host.hostId)?.connectivity === "connected",
      );
    } finally {
      await second.stop();
    }
  });

  it("opens the first link in the browser with --open", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sy-up-"));
    const ctx = testCtx((i, init) => fetch(i, init));
    const opened: string[] = [];
    const s = await startStandalone(
      ctx,
      { port: "0", host: "127.0.0.1", dataDir, name: "h", webDist: "/nonexistent", open: true },
      { open: (u) => opened.push(u) },
    );
    try {
      expect(opened).toEqual([s.firstLink]);
    } finally {
      await s.stop();
    }
  });

  it("openBrowser uses open on macOS and xdg-open on Linux, detached", () => {
    const spawned: unknown[][] = [];
    const fake = ((cmd: string, args: string[], opts: unknown) => {
      spawned.push([cmd, args, opts]);
      return { on() {}, unref() {} };
    }) as never;
    openBrowser("http://localhost:1/x", "darwin", fake);
    openBrowser("http://localhost:1/x", "linux", fake);
    openBrowser("http://localhost:1/x", "win32", fake);
    expect(spawned).toEqual([
      ["open", ["http://localhost:1/x"], { detached: true, stdio: "ignore" }],
      ["xdg-open", ["http://localhost:1/x"], { detached: true, stdio: "ignore" }],
    ]);
  });
});
