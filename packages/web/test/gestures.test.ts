import { describe, expect, it } from "vitest";
import {
  dismissResult,
  edgeBackResult,
  fullSwipeAt,
  lockAxis,
  pageResult,
  REVEAL,
  rubberBand,
  swipeResult,
  velocity,
} from "../src/lib/gestures";

const both = {
  width: 300,
  reveal: { leading: REVEAL, trailing: 2 * REVEAL },
  fullSwipe: { leading: true, trailing: true },
};

describe("gestures", () => {
  it("locks the axis only past the slop", () => {
    expect(lockAxis(5, 5)).toBeNull();
    expect(lockAxis(20, 5)).toBe("x");
    expect(lockAxis(5, 20)).toBe("y");
    expect(lockAxis(12, 11)).toBe("y");
  });

  it("rubber bands without reaching the limit", () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(50, 100)).toBeGreaterThan(0);
    expect(rubberBand(200, 100)).toBeGreaterThan(rubberBand(50, 100));
    expect(rubberBand(1e6, 100)).toBeLessThan(100);
    expect(rubberBand(-50, 100)).toBeLessThan(0);
  });

  it("decides a row swipe", () => {
    expect(swipeResult(0, 0, both)).toEqual({ kind: "close" });
    expect(swipeResult(-100, 0, { ...both, reveal: { leading: REVEAL, trailing: 0 } })).toEqual({
      kind: "close",
    });
    expect(swipeResult(-(REVEAL + 1), 0, both)).toEqual({ kind: "open", side: "trailing" });
    expect(swipeResult(10, 0, both)).toEqual({ kind: "close" });
    expect(swipeResult(fullSwipeAt(300, REVEAL), 0, both)).toEqual({
      kind: "commit",
      side: "leading",
    });
    expect(swipeResult(-2 * REVEAL, -1.5, both)).toEqual({ kind: "commit", side: "trailing" });
    // Flicking back while open closes.
    expect(swipeResult(-2 * REVEAL, 0.5, both)).toEqual({ kind: "close" });
    expect(
      swipeResult(-250, 0, { ...both, fullSwipe: { leading: true, trailing: false } }),
    ).toEqual({ kind: "open", side: "trailing" });
  });

  it("decides sheet, page and edge-back releases", () => {
    expect(dismissResult(100, 0, 300)).toBe(true);
    expect(dismissResult(30, 1, 300)).toBe(false);
    expect(dismissResult(50, 0.6, 300)).toBe(true);
    expect(dismissResult(20, 0, 300)).toBe(false);
    expect(pageResult(-100, 0, 300)).toBe(1);
    expect(pageResult(-50, -0.5, 300)).toBe(1);
    expect(pageResult(100, 0, 300)).toBe(-1);
    expect(pageResult(20, 0.1, 300)).toBe(0);
    expect(edgeBackResult(120, 0, 300)).toBe(true);
    expect(edgeBackResult(70, 0.6, 300)).toBe(true);
    expect(edgeBackResult(40, 0.1, 300)).toBe(false);
  });

  it("measures velocity over the last 100 ms", () => {
    expect(velocity([])).toBe(0);
    expect(velocity([{ t: 0, v: 0 }])).toBe(0);
    expect(
      velocity([
        { t: 0, v: 0 },
        { t: 200, v: 500 },
        { t: 250, v: 600 },
      ]),
    ).toBe(2);
    expect(
      velocity([
        { t: 5, v: 0 },
        { t: 5, v: 10 },
      ]),
    ).toBe(0);
  });
});
