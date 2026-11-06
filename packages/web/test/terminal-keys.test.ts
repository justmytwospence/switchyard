import { describe, expect, it } from "vitest";
import {
  applyModifiers,
  fitFontSize,
  fromBase64,
  terminalSocketUrl,
  toBase64,
} from "../src/features/code/terminalKeys";

describe("terminal keys", () => {
  it("applies sticky modifiers", () => {
    const none = { ctrl: false, alt: false };
    expect(applyModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
    expect(applyModifiers("C", { ctrl: true, alt: false })).toBe("\x03");
    expect(applyModifiers("?", { ctrl: true, alt: false })).toBe("\x7f");
    expect(applyModifiers("[", { ctrl: true, alt: false })).toBe("\x1b");
    expect(applyModifiers("x", { ctrl: false, alt: true })).toBe("\x1bx");
    expect(applyModifiers("\x1b[A", { ctrl: true, alt: false })).toBe("\x1b[A");
    expect(applyModifiers("a", none)).toBe("a");
  });
  it("clamps the font size", () => {
    expect(fitFontSize(10000, 10, 8)).toBe(13);
    expect(fitFontSize(100, 200, 8)).toBe(6);
    expect(fitFontSize(400, 80, 8)).toBe(8);
  });
  it("builds the socket url", () => {
    expect(terminalSocketUrl({ protocol: "http:", host: "h:1" }, "a b", 80, 24)).toBe(
      "ws://h:1/ws/terminal/a%20b?cols=80&rows=24&passive=1",
    );
    expect(terminalSocketUrl({ protocol: "https:", host: "h" }, "s", 1, 2)).toMatch(/^wss:/);
  });
  it("round-trips utf-8 base64", () => {
    const text = "héllo ✓ 日本";
    expect(new TextDecoder().decode(fromBase64(toBase64(text)))).toBe(text);
  });
});
