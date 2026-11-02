import { validateUINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  genericClaim,
  genericStatusPanel,
  genericToolCard,
  InteractionResponseError,
  type PiUiRequest,
  parseFrameMessage,
  parsePiUiRequest,
} from "../src/index.js";

const select: PiUiRequest = {
  id: "r1",
  method: "select",
  title: "Pick a fruit",
  options: ["Apple", "Banana"],
};

describe("genericClaim", () => {
  it("select -> single-select form -> {value}", async () => {
    const c = genericClaim(select);
    expect(validateUINode(c.presentation)).toMatchObject({
      t: "form",
      fields: [
        { kind: "select", name: "value", options: [{ value: "Apple" }, { value: "Banana" }] },
      ],
    });
    expect(await c.toPiResponse({ kind: "form", values: { value: "Banana" } })).toEqual({
      value: "Banana",
    });
    expect(await c.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
    expect(() => c.toPiResponse({ kind: "form", values: { value: "Cherry" } })).toThrow(
      InteractionResponseError,
    );
  });

  it("keeps a multi-line title visible above the form", () => {
    const c = genericClaim({ ...select, title: "Allow this call?\nAction: bash" });
    expect(c.title).toBe("Allow this call?");
    expect(c.presentation).toMatchObject({
      t: "section",
      children: [{ t: "text" }, { t: "form" }],
    });
  });

  it("confirm -> confirm node -> {confirmed}", async () => {
    const c = genericClaim({ id: "r2", method: "confirm", title: "Clear?", message: "All lost." });
    expect(c.presentation).toMatchObject({ t: "confirm", message: "All lost." });
    expect(await c.toPiResponse({ kind: "confirm", confirmed: false })).toEqual({
      confirmed: false,
    });
    expect(await c.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
  });

  it("input -> text field, editor -> multiline with prefill", async () => {
    const i = genericClaim({ id: "r3", method: "input", title: "Name", placeholder: "type" });
    expect(i.presentation).toMatchObject({ fields: [{ kind: "text", placeholder: "type" }] });
    expect(await i.toPiResponse({ kind: "form", values: { value: "x" } })).toEqual({ value: "x" });
    const e = genericClaim({ id: "r4", method: "editor", title: "Edit", prefill: "a\nb" });
    expect(e.presentation).toMatchObject({
      fields: [{ kind: "text", multiline: true, prefill: "a\nb" }],
    });
    expect(await e.toPiResponse({ kind: "form", values: { value: "c" } })).toEqual({ value: "c" });
    expect(await e.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
  });
});

describe("generic cards and panels", () => {
  it("tool card shows status, args and output", () => {
    const running = genericToolCard({ toolCallId: "t", name: "bash", args: { command: "ls" } });
    expect(validateUINode(running)).toMatchObject({ t: "section", title: "bash" });
    expect(JSON.stringify(running)).toContain('"status":"running"');
    const done = genericToolCard({
      toolCallId: "t",
      name: "bash",
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "a.txt" }] },
      isError: false,
    });
    expect(JSON.stringify(done)).toContain("a.txt");
  });

  it("status panel is a sorted key/text table, null when empty", () => {
    expect(genericStatusPanel(new Map())).toBeNull();
    expect(
      genericStatusPanel(
        new Map([
          ["z", "2"],
          ["a", "1"],
        ]),
      ),
    ).toEqual({
      t: "table",
      columns: ["Key", "Status"],
      rows: [
        ["a", "1"],
        ["z", "2"],
      ],
    });
  });
});

describe("wire parsing", () => {
  it("parses dialog requests and ignores fire-and-forget methods", () => {
    expect(parsePiUiRequest({ type: "extension_ui_request", ...select })).toEqual(select);
    expect(parsePiUiRequest({ id: "x", method: "notify", message: "hi" })).toBeUndefined();
  });

  it("validates frame messages", () => {
    expect(parseFrameMessage({ type: "resize", height: 120 })).toEqual({
      type: "resize",
      height: 120,
    });
    expect(parseFrameMessage({ type: "action", actionId: "go", payload: 1 })).toMatchObject({
      actionId: "go",
    });
    expect(parseFrameMessage({ type: "resize", height: 1e9 })).toBeUndefined();
    expect(parseFrameMessage({ type: "navigate", url: "https://x" })).toBeUndefined();
  });
});
