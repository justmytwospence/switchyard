import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startStandalone } from "../src/commands/up.js";
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

    const first = await startStandalone(ctx, flags);
    try {
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

    const second = await startStandalone(ctx, flags);
    try {
      expect(second.host.hostId).toBe(first.host.hostId);
      expect(second.coordinator.store.hosts.list().filter((h) => !h.revokedAt)).toHaveLength(1);
      await until(
        () => second.coordinator.store.hosts.get(second.host.hostId)?.connectivity === "connected",
      );
    } finally {
      await second.stop();
    }
  });
});
