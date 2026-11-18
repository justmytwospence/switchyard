// @module-tag slow
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManagedSession, resolvePiPackageRoot } from "@switchyard/pi-runtime";
import { piBin, skipRealPi, when } from "@switchyard/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { AdapterCatalog } from "../src/adapters.js";
import { slowPi, startCommand, startHarness, waitFor } from "./helpers.js";

function ownerFixture(stateDir: string) {
  const dir = join(stateDir, "owner-adapters", "startup-fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify({
      id: "startup-fixture",
      version: "1.0.0",
      protocolVersion: 1,
      target: { extension: "fixture", versionRange: "*", testedVersions: [] },
      server: "server.mjs",
      webRenderer: null,
      capabilities: ["panels"],
    }),
  );
  writeFileSync(
    join(dir, "server.mjs"),
    `export default {
    onRestore(ctx) { ctx.setPanel('ready', {t:'text', text:'ready'}); },
  };`,
  );
}

describe.skipIf(skipRealPi)("adapter startup", () => {
  it("waits for a slow Pi before inspecting authenticated resources and accepting the launch prompt", async () => {
    const slow = slowPi(6);
    // The wrapper lives outside Pi's package; expose the real resolver API without copying it.
    const root = resolvePiPackageRoot(piBin());
    if (!root) throw new Error("Cannot locate the real Pi package");
    writeFileSync(
      join(dirname(slow.path), "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );
    symlinkSync(join(root, "dist"), join(dirname(slow.path), "dist"), "dir");
    const h = await startHarness({
      piBin: slow.path,
      script: [{ when: when.userSays("hello"), reply: { text: "hello back" } }],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let promptReached = false;
    const originalPrompt = ManagedSession.prototype.prompt;
    const prompt = vi.spyOn(ManagedSession.prototype, "prompt").mockImplementation(async function (
      ...args
    ) {
      promptReached = true;
      await gate;
      return originalPrompt.apply(this, args);
    });
    const prepare = vi.spyOn(AdapterCatalog.prototype, "prepareSession");
    try {
      ownerFixture(h.stateDir);
      const id = "ses_adapter_cold_start";
      const t0 = Date.now();
      const started = h.coord.ok(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
      await waitFor(() => h.agent.supervisor.record(id)?.runtime === "starting", 15000, "starting");
      await waitFor(() => promptReached, 30000, "initial prompt dispatch");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(6000);
      expect(h.agent.supervisor.record(id)?.runtime).toBe("starting");
      expect(prepare).toHaveBeenCalled();
      const input = prepare.mock.calls.find(([value]) => value.sessionId === id)?.[0];
      expect(input).toMatchObject({
        projectTrusted: expect.any(Boolean),
        resources: { status: "available", diagnostics: [] },
      });
      expect(
        h.agent.supervisor.managedSession(id)?.bridgeFeatures?.capabilities.resourceSnapshot,
      ).toBe(true);
      expect(
        h.agent.supervisor
          .sessionAdapters(id)
          .diagnostics.map((d) => d.message)
          .join(" "),
      ).not.toMatch(/legacy|resource snapshot is unavailable|does not report resources/i);
      expect(h.agent.supervisor.panels(id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slot: "ready", node: { t: "text", text: "ready" } }),
        ]),
      );
      release();
      await started;
      await h.coord.waitUntil(
        () => h.coord.eventsOf("session.updated", id).some((e) => (e.data as any).settled != null),
        30000,
        "initial prompt settled",
      );
      expect(h.agent.supervisor.record(id)?.lastAssistantText).toContain("hello back");
      await h.coord.ok({ type: "session.stop", sessionId: id });
    } finally {
      release();
      prompt.mockRestore();
      prepare.mockRestore();
      await h.dispose();
      slow.cleanup();
    }
  }, 60000);

  it("stops an initial start without deadlocking or leaving work writing to a closed database", async () => {
    const slow = slowPi(6);
    const h = await startHarness({ piBin: slow.path });
    try {
      ownerFixture(h.stateDir);
      const id = "ses_adapter_cancel_start";
      const started = h.coord.command(startCommand(id, h.pi!.cwd, { initialPrompt: "hello" }));
      await waitFor(() => h.agent.supervisor.record(id)?.runtime === "starting", 15000, "starting");
      const t0 = Date.now();
      await h.coord.ok({ type: "session.stop", sessionId: id });
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(await started).toMatchObject({ ok: true, result: { runtime: "stopped" } });
      expect(h.agent.supervisor.isLive(id)).toBe(false);
      await h.agent.stop();
    } finally {
      await h.dispose();
      slow.cleanup();
    }
  }, 30000);
});
