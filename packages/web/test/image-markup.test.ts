import { describe, expect, it } from "vitest";
import {
  arrowHead,
  exportGeometry,
  initialHistory,
  type MarkupAction,
  markupReducer,
  type Shape,
  strokeWidth,
} from "../src/features/code/imageMarkup";

const arrow: Shape = { kind: "arrow", a: [0.1, 0.1], b: [0.5, 0.5] };
const run = (...actions: MarkupAction[]) => actions.reduce(markupReducer, initialHistory());

describe("markupReducer", () => {
  it("adds, undoes and redoes", () => {
    const h = run({ type: "add", shape: arrow });
    expect(h.present.shapes).toEqual([arrow]);
    const u = markupReducer(h, { type: "undo" });
    expect(u.present.shapes).toEqual([]);
    expect(markupReducer(u, { type: "redo" }).present.shapes).toEqual([arrow]);
    expect(markupReducer(initialHistory(), { type: "undo" })).toEqual(initialHistory());
  });

  it("clears redo on a new action and makes reset undoable", () => {
    let h = run({ type: "add", shape: arrow }, { type: "undo" });
    h = markupReducer(h, { type: "add", shape: arrow });
    expect(h.future).toEqual([]);
    const r = markupReducer(h, { type: "reset" });
    expect(r.present).toEqual({ crop: null, shapes: [] });
    expect(markupReducer(r, { type: "undo" }).present.shapes).toEqual([arrow]);
  });

  it("normalizes a crop and drops a tiny one", () => {
    const h = run({ type: "crop", crop: { a: [0.8, 0.9], b: [0.2, 0.1] } });
    expect(h.present.crop).toEqual({ a: [0.2, 0.1], b: [0.8, 0.9] });
    expect(run({ type: "crop", crop: { a: [0.1, 0.1], b: [0.105, 0.5] } }).present.crop).toBeNull();
  });
});

describe("exportGeometry", () => {
  it("keeps the full image without a crop and never upscales", () => {
    expect(exportGeometry(800, 600, null)).toEqual({
      sx: 0,
      sy: 0,
      sw: 800,
      sh: 600,
      dw: 800,
      dh: 600,
    });
  });
  it("crops", () => {
    const g = exportGeometry(1000, 1000, { a: [0.25, 0.25], b: [0.75, 0.5] });
    expect(g).toMatchObject({ sx: 250, sy: 250, sw: 500, sh: 250, dw: 500, dh: 250 });
  });
  it("downscales to the longest side", () => {
    const g = exportGeometry(8192, 4096, null);
    expect(g.dw).toBe(4096);
    expect(g.dh).toBe(2048);
  });
});

describe("arrowHead and strokeWidth", () => {
  it("makes symmetric barbs", () => {
    const [p, q] = arrowHead([0, 0], [1, 0], 0.1);
    expect(p[0]).toBeCloseTo(q[0]);
    expect(p[1]).toBeCloseTo(-q[1]);
    expect(p[0]).toBeLessThan(1);
  });
  it("has a minimum", () => {
    expect(strokeWidth(100, 100)).toBe(4);
    expect(strokeWidth(4000, 3000)).toBe(16);
  });
});
