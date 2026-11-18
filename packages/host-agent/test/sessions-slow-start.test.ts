// @module-tag slow
import { describe, expect, it } from "vitest";
import { slowPi, startCommand, startHarness, waitFor } from "./helpers.js";
import { script, sid } from "./sessions-helpers.js";

describe("session.stop during a slow start", () => {
  it("stops it without waiting for Pi", async () => {
    const slow = slowPi(20);
    const w = await startHarness({ script, piBin: slow.path });
    try {
      const id = sid();
      const started = w.coord.command(startCommand(id, w.pi!.cwd));
      await waitFor(() => w.agent.supervisor.record(id)?.runtime === "starting", 15000, "starting");
      const t0 = Date.now();
      await w.coord.ok({ type: "session.stop", sessionId: id });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(w.agent.supervisor.record(id)?.runtime).toBe("stopped");
      const receipt = await started;
      expect(receipt).toMatchObject({ ok: true, result: { runtime: "stopped" } });
      expect(w.agent.supervisor.isLive(id)).toBe(false);
    } finally {
      await w.dispose();
      slow.cleanup();
    }
  });
});
