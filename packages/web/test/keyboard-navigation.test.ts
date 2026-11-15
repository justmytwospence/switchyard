import { describe, expect, it } from "vitest";
import { adjacentColumnTarget, nextIndex } from "../src/features/palette/navigation";
import { NAVIGATION_SHORTCUTS } from "../src/features/palette/shortcuts";

describe("keyboard navigation", () => {
  it("clamps row movement without wrapping and treats empty lists safely", () => {
    expect(nextIndex(-1, 0, 1)).toBe(-1);
    expect(nextIndex(-1, 3, 1)).toBe(0);
    expect(nextIndex(-1, 3, -1)).toBe(2);
    expect(nextIndex(0, 3, -1)).toBe(0);
    expect(nextIndex(2, 3, 1)).toBe(2);
  });
  it("skips empty columns and retains the nearest valid row", () => {
    expect(adjacentColumnTarget([3, 0, 1, 4], 0, 2, 1)).toEqual({ column: 2, row: 0 });
    expect(adjacentColumnTarget([3, 0, 1, 4], 3, 3, -1)).toEqual({ column: 2, row: 0 });
    expect(adjacentColumnTarget([3, 0, 1, 4], 3, 0, 1)).toBeNull();
    expect(adjacentColumnTarget([0, 0], 0, 0, 1)).toBeNull();
  });
  it("keeps display bindings distinct by action", () => {
    expect(new Set(NAVIGATION_SHORTCUTS.map((item) => item.action)).size).toBe(
      NAVIGATION_SHORTCUTS.length,
    );
    expect(NAVIGATION_SHORTCUTS.find((item) => item.action === "first")?.keys).toBe("g g");
  });
});
