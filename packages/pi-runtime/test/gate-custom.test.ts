import type { TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("gate: custom (terminal-only UI)", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      {
        when: when.userSays("custom"),
        reply: { toolCalls: [{ name: "fixture_custom", arguments: {} }] },
      },
      { when: when.toolResult(), reply: (r) => ({ text: `tool said: ${r.lastText}` }) },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("the bridge reports kind custom and the extension receives undefined", async () => {
    const s = h.newSession();
    const rec = record(s, ["bridge", "item", "ui_request"]);
    await s.start();
    const end = waitFor(s, "bridge", (b: any) => b.type === "ui_prompt_end" && b.kind === "custom");
    const settled = waitFor(s, "settled");
    await s.prompt("open the custom thing");
    await settled;
    await end;

    const bridge = rec.of("bridge");
    expect(bridge.find((b) => b.type === "ui_prompt_start")).toMatchObject({ kind: "custom" });
    expect(bridge.find((b) => b.type === "ui_prompt_end")).toMatchObject({ kind: "custom" });
    // RPC mode sends no extension_ui_request for custom()
    expect(rec.of("ui_request")).toEqual([]);

    const tool = (rec.of("item") as TranscriptItem[])
      .filter((i) => i.kind === "tool")
      .at(-1) as Extract<TranscriptItem, { kind: "tool" }>;
    expect(tool.data).toMatchObject({ name: "fixture_custom", status: "ok" });
    expect(tool.data.output).toBe("custom returned undefined");
  });
});
