import { describe, expect, it } from "vitest";
import { keyboardOpen } from "../src/app/useComposing";

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
