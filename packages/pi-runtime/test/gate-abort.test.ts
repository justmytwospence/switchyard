import type { TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("gate: abort", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      {
        when: when.userSays("slow"),
        reply: { toolCalls: [{ name: "fixture_slow", arguments: {} }] },
      },
      {
        when: when.userSays("ask"),
        reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
      },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("aborts a running tool within 2 s; settled reports aborted and runtime returns to idle", async () => {
    const s = h.newSession();
    const rec = record(s, ["item", "settled"]);
    await s.start();
    const toolStarted = waitFor(s, "pi_event", (e: any) => e.type === "tool_execution_start");
    await s.prompt("run something slow");
    await toolStarted;
    expect(s.runtime).toBe("running");

    const t0 = Date.now();
    const settled = waitFor(s, "settled");
    await s.abort();
    const info = await settled;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(info.aborted).toBe(true);
    expect(s.runtime).toBe("idle");

    const items = rec.of("item") as TranscriptItem[];
    const tool = items.filter((i) => i.kind === "tool").at(-1) as Extract<
      TranscriptItem,
      { kind: "tool" }
    >;
    expect(tool.data).toMatchObject({ name: "fixture_slow", status: "error" });
    expect(items.some((i) => i.kind === "notice" && i.data.text === "Run aborted")).toBe(true);
    // the abort's own "operation was aborted" error is not shown as an error notice
    expect(items.some((i) => i.kind === "notice" && i.data.level === "error")).toBe(false);

    // the session keeps working after an abort
    h.mock.setScript([]);
    const again = waitFor(s, "settled");
    await s.prompt("hello again");
    expect((await again).lastAssistantText).toBe("ok");
  });

  it("abort while a dialog is pending: Pi closes the dialog and the bridge expires it", async () => {
    h.mock.setScript([
      {
        when: when.userSays("ask"),
        reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
      },
    ]);
    const s = h.newSession();
    const rec = record(s, ["ui_resolved"]);
    await s.start();
    const request = waitFor(s, "ui_request", (r: any) => r.method === "select");
    await s.prompt("ask me");
    await request;
    expect(s.runtime).toBe("waiting_input");
    const resolved = waitFor(s, "ui_resolved");
    const settled = waitFor(s, "settled");
    const { cleared } = await s.abort(true);
    expect(cleared).toEqual({ steering: [], followUp: [] });
    expect((await settled).aborted).toBe(true);
    expect((await resolved).by).toBe("pi");
    expect(rec.of("ui_resolved")).toHaveLength(1);
    expect(s.pendingUi).toEqual([]);
    expect(s.runtime).toBe("idle");
  });
});
