import { describe, expect, it } from "vitest";
import { keyboardOpen } from "../src/app/useComposing";
import { appendQuote, applyReplyNotes, quoteBlock } from "../src/drafts";
import { spliceAtCaret } from "../src/features/code/dictation";

describe("keyboardOpen", () => {
  it("is false when no text field is focused", () => {
    expect(
      keyboardOpen({ focused: false, viewportHeight: 300, baseline: 844, screenHeight: 844 }),
    ).toBe(false);
  });

  it("is true when the viewport is under 75% of the baseline", () => {
    expect(
      keyboardOpen({ focused: true, viewportHeight: 500, baseline: 844, screenHeight: 844 }),
    ).toBe(true);
  });

  it("is false for a small shrink such as a collapsing URL bar", () => {
    expect(
      keyboardOpen({ focused: true, viewportHeight: 800, baseline: 844, screenHeight: 844 }),
    ).toBe(false);
  });

  it("detects the keyboard on Android where innerHeight shrinks with it", () => {
    // The baseline (unfocused) is 844; both innerHeight and visualViewport report 464.
    expect(
      keyboardOpen({ focused: true, viewportHeight: 464, baseline: 844, screenHeight: 844 }),
    ).toBe(true);
  });

  it("falls back to the screen height without a baseline", () => {
    expect(
      keyboardOpen({ focused: true, viewportHeight: 500, baseline: null, screenHeight: 844 }),
    ).toBe(true);
    expect(
      keyboardOpen({ focused: true, viewportHeight: 700, baseline: null, screenHeight: 844 }),
    ).toBe(false);
  });
});

describe("reply notes", () => {
  const note = (quote: string, comment: string) => ({
    id: "rn_1",
    quote,
    comment,
    createdAt: "2026-11-01T10:00:00.000Z",
  });

  it("quotes every line, blank lines as a bare marker", () => {
    expect(quoteBlock("a\n\nb")).toBe("> a\n>\n> b");
  });

  it("prepends notes to the message, notes only, or skips slash commands", () => {
    expect(applyReplyNotes([], "hi")).toBe("hi");
    expect(applyReplyNotes([note("x", "why?")], "hi")).toBe("> x\nwhy?\n\nhi");
    expect(applyReplyNotes([note("x", "why?")], "")).toBe("> x\nwhy?");
    expect(applyReplyNotes([note("x", "why?")], "/compact")).toBe("/compact");
    expect(applyReplyNotes([note("a\nb", " c ")], "t")).toBe("> a\n> b\nc\n\nt");
  });

  it("appends a quote to a blank or existing draft", () => {
    expect(appendQuote("", "q")).toBe("> q\n\n");
    expect(appendQuote("hello  \n", "q")).toBe("hello\n\n> q\n\n");
  });
});

describe("spliceAtCaret", () => {
  it("adds spaces where the insert would touch words", () => {
    expect(spliceAtCaret("hello", 5, 5, " world ")).toEqual({ text: "hello world", caret: 11 });
    expect(spliceAtCaret("ab", 1, 1, "x")).toEqual({ text: "a x b", caret: 4 });
  });
  it("handles an empty draft and an empty insert", () => {
    expect(spliceAtCaret("", 0, 0, "hi")).toEqual({ text: "hi", caret: 2 });
    expect(spliceAtCaret("abc", 1, 1, "  ")).toEqual({ text: "abc", caret: 1 });
  });
  it("replaces a selection", () => {
    expect(spliceAtCaret("a OLD b", 2, 5, "new")).toEqual({ text: "a new b", caret: 5 });
  });
});
