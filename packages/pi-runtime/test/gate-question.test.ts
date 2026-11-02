import type { TranscriptItem } from "@switchyard/protocol";
import { when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiUiRequest } from "../src/index.js";
import { type PiHarness, record, setupPi, skipRealPi, waitFor } from "./helpers.js";

const callTool = (name: string) => ({ toolCalls: [{ name, arguments: {} }] });

describe.skipIf(skipRealPi)("gate: question (extension dialogs)", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      { when: when.userSays("pick"), reply: callTool("fixture_select") },
      { when: when.userSays("confirm"), reply: callTool("fixture_confirm") },
      { when: when.userSays("input"), reply: callTool("fixture_input") },
      { when: when.userSays("editor"), reply: callTool("fixture_editor") },
      { when: when.userSays("status"), reply: callTool("fixture_status") },
      { when: when.toolResult(), reply: (r) => ({ text: `tool said: ${r.lastText}` }) },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("forwards a select, accepts our answer, and the bridge reports the prompt", async () => {
    const s = h.newSession();
    const rec = record(s, ["item", "runtime", "bridge", "ui_request", "ui_resolved", "settled"]);
    await s.start();
    expect(s.process?.bridgeSocket).toBeTruthy();

    const request = waitFor<PiUiRequest>(s, "ui_request", (r) => r.method === "select");
    await s.prompt("please pick a fruit");
    const req = await request;
    expect(req).toMatchObject({
      method: "select",
      title: "Pick a fruit",
      options: ["Apple", "Banana"],
    });
    expect(s.runtime).toBe("waiting_input");
    expect(s.pendingUi.map((r) => r.id)).toEqual([req.id]);

    const promptEnd = waitFor(s, "bridge", (b: any) => b.type === "ui_prompt_end");
    const settled = waitFor(s, "settled");
    await s.respondUi(req.id, { value: "Banana" });
    const info = await settled;
    await promptEnd;

    const tool = (rec.of("item") as TranscriptItem[])
      .filter((i) => i.kind === "tool")
      .at(-1) as Extract<TranscriptItem, { kind: "tool" }>;
    expect(tool.data).toMatchObject({ name: "fixture_select", status: "ok" });
    expect(tool.data.output).toContain("Banana");
    expect(info.lastAssistantText).toBe("tool said: selected Banana");

    const bridge = rec.of("bridge");
    expect(bridge.find((b) => b.type === "hello")).toBeTruthy();
    expect(bridge.find((b) => b.type === "ui_prompt_start")).toMatchObject({
      kind: "select",
      title: "Pick a fruit",
    });
    expect(bridge.find((b) => b.type === "ui_prompt_end")).toMatchObject({
      kind: "select",
      title: "Pick a fruit",
    });
    expect(rec.of("ui_resolved")).toEqual([{ id: req.id, by: "host", request: req }]);
    expect(rec.of("runtime").map((r) => r.runtime)).toEqual([
      "idle",
      "running",
      "waiting_input",
      "running",
      "idle",
    ]);
  });

  it("handles confirm, input, editor and cancellation", async () => {
    const s = h.newSession();
    await s.start();
    const ask = async (prompt: string, method: string, body: any) => {
      const request = waitFor<PiUiRequest>(s, "ui_request", (r) => r.method === method);
      const settled = waitFor(s, "settled");
      await s.prompt(prompt);
      const req = await request;
      await s.respondUi(req.id, body);
      return { req, info: await settled };
    };

    const c = await ask("please confirm", "confirm", { confirmed: true });
    expect(c.req).toMatchObject({ title: "Proceed?", message: "The fixture wants to continue." });
    expect(c.info.lastAssistantText).toBe("tool said: confirmed true");

    const i = await ask("please input", "input", { value: "Ada" });
    expect(i.req).toMatchObject({ title: "Your name", placeholder: "type a name" });
    expect(i.info.lastAssistantText).toBe("tool said: input Ada");

    const e = await ask("please editor", "editor", { value: "edited" });
    expect(e.req).toMatchObject({ title: "Edit the note", prefill: "line 1\nline 2" });
    expect(e.info.lastAssistantText).toBe("tool said: editor edited");

    const x = await ask("please pick again", "select", { cancelled: true });
    expect(x.info.lastAssistantText).toBe("tool said: selected undefined");
  });

  it("forwards fire-and-forget status, widget and notify requests", async () => {
    const s = h.newSession();
    const rec = record(s, ["ui_request"]);
    await s.start();
    const settled = waitFor(s, "settled");
    await s.prompt("please status");
    await settled;
    const reqs = rec.of("ui_request");
    expect(reqs.find((r) => r.method === "setStatus")).toMatchObject({
      statusKey: "fixture",
      statusText: "fixture working",
    });
    expect(reqs.find((r) => r.method === "setWidget")).toMatchObject({
      widgetKey: "fixture",
      widgetLines: ["fixture widget line 1", "fixture widget line 2"],
    });
    expect(reqs.find((r) => r.method === "notify")).toMatchObject({
      message: "fixture notified",
      notifyType: "info",
    });
    expect(s.pendingUi).toEqual([]);
  });
});
