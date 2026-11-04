import { describe, expect, it } from "vitest";
import { nextShownLength, revealRate } from "../src/lib/useSmoothText";

describe("smooth text reveal", () => {
  it("never passes the target and stops there", () => {
    expect(nextShownLength(10, 10, 16, 100)).toBe(10);
    expect(nextShownLength(12, 10, 16, 100)).toBe(10);
    expect(nextShownLength(9, 10, 1000, 100)).toBe(10);
  });
  it("drains a burst evenly in about 160 ms", () => {
    const rate = revealRate(800);
    let shown = 0;
    let frames = 0;
    while (shown < 800 && frames < 100) {
      shown = nextShownLength(shown, 800, 16, rate);
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(9);
    expect(frames).toBeLessThanOrEqual(12);
  });
  it("still moves on a small backlog", () => {
    expect(revealRate(1)).toBe(60);
    expect(nextShownLength(0, 3, 16, revealRate(3))).toBe(1);
  });
});
