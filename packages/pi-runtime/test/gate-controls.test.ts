import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { terminalSupport } from "../src/terminal-process.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

const transports: ("rpc" | "terminal")[] = ["rpc"];
if (terminalSupport().ok) transports.push("terminal");

describe.skipIf(skipRealPi)("gate: session controls", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi(
      [
        {
          when: when.userSays("structured context checkpoint summary"),
          reply: { text: "## Goal\nCompacted by the gate test." },
        },
        { when: when.userSays("first"), reply: { text: "first answer" } },
        { when: when.userSays("second"), reply: { text: "second answer" } },
      ],
      { settings: { compaction: { keepRecentTokens: 1 } } },
    );
  });
  afterAll(async () => {
    await h?.dispose();
  });

  for (const transport of transports) {
    it(`model, effort, commands, context and compaction (${transport})`, async () => {
      const s = h.newSession({ transport });
      const rec = record(s, ["item", "model", "compacting", "ui_request"]);
      await s.start();
      expect(s.modelState.model).toMatchObject({
        provider: "mock",
        id: "mock-1",
        thinkingLevels: ["off"],
      });

      const models = await s.models();
      expect(models.find((m) => m.id === "mock-2")?.thinkingLevels).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      const changed = await s.setModel("mock", "mock-2");
      expect(changed.model?.id).toBe("mock-2");
      expect(rec.of("model").length).toBeGreaterThan(0);
      expect((await s.setThinking("high")).thinking).toBe("high");

      expect(await s.commands()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "fixture-hello", source: "extension" }),
        ]),
      );
      expect(await s.prompt("/fixture-hello world")).toBe("handled");
      const seen = () =>
        (rec.of("ui_request") as any[]).some(
          (r) => r.method === "notify" && r.message === "fixture hello world",
        );
      for (let i = 0; i < 100 && !seen(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen()).toBe(true);

      for (const text of ["first", "second"]) {
        const settled = waitFor(s, "settled");
        await s.prompt(text);
        await settled;
      }
      expect((await s.stats()).context?.window).toBe(200000);

      const states: boolean[] = [];
      s.on("compacting", (c) => states.push(c));
      await s.compact(null);
      await waitFor(s, "compacting", (c: boolean) => c === false);
      expect(states[0]).toBe(true);
      const items = rec.of("item") as any[];
      expect(items.some((i) => i.kind === "notice" && i.data.text === "Context compacted")).toBe(
        true,
      );
    });
  }

  it("vanilla keeps Switchyard's and explicit extensions (rpc)", async () => {
    const s = h.newSession({
      transport: "rpc",
      profile: {
        provider: "mock",
        model: "mock-1",
        thinking: null,
        projectTrust: "ask",
        extraArgs: [],
        resources: "vanilla",
      },
    });
    await s.start();
    expect(s.modelState.model?.id).toBe("mock-1");
    expect((await s.commands()).some((c) => c.name === "fixture-hello")).toBe(true);
  });
});
