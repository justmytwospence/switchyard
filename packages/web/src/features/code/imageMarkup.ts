/** Pure geometry and history for the image markup editor (normalized 0..1 coordinates). */

export type Pt = [number, number];
export type Shape =
  | { kind: "pen"; points: Pt[] }
  | { kind: "ellipse"; a: Pt; b: Pt }
  | { kind: "arrow"; a: Pt; b: Pt };
export interface Markup {
  crop: { a: Pt; b: Pt } | null;
  shapes: Shape[];
}
export interface History {
  past: Markup[];
  present: Markup;
  future: Markup[];
}
export type MarkupAction =
  | { type: "add"; shape: Shape }
  | { type: "crop"; crop: Markup["crop"] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

export const MARKUP_COLOR = "#ef4444";
export const EMPTY_MARKUP: Markup = { crop: null, shapes: [] };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Min/max normalized and clamped; a crop under 1% in either dimension is no crop. */
export function normalizeCrop(crop: Markup["crop"]): Markup["crop"] {
  if (!crop) return null;
  const x0 = clamp01(Math.min(crop.a[0], crop.b[0]));
  const x1 = clamp01(Math.max(crop.a[0], crop.b[0]));
  const y0 = clamp01(Math.min(crop.a[1], crop.b[1]));
  const y1 = clamp01(Math.max(crop.a[1], crop.b[1]));
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { a: [x0, y0], b: [x1, y1] };
}

export function initialHistory(): History {
  return { past: [], present: EMPTY_MARKUP, future: [] };
}

export function markupReducer(h: History, a: MarkupAction): History {
  const push = (present: Markup): History => ({
    past: [...h.past, h.present],
    present,
    future: [],
  });
  switch (a.type) {
    case "add":
      return push({ ...h.present, shapes: [...h.present.shapes, a.shape] });
    case "crop":
      return push({ ...h.present, crop: normalizeCrop(a.crop) });
    case "reset":
      return push({ crop: null, shapes: [] });
    case "undo": {
      const prev = h.past[h.past.length - 1];
      if (!prev) return h;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    }
    case "redo": {
      const next = h.future[0];
      if (!next) return h;
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    }
  }
}

/** Source rectangle and output size: longest side at most `max`, never upscaled. */
export function exportGeometry(
  w: number,
  h: number,
  crop: Markup["crop"],
  max = 4096,
): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } {
  const c = normalizeCrop(crop);
  const sx = c ? Math.round(c.a[0] * w) : 0;
  const sy = c ? Math.round(c.a[1] * h) : 0;
  const sw = c ? Math.max(1, Math.round((c.b[0] - c.a[0]) * w)) : w;
  const sh = c ? Math.max(1, Math.round((c.b[1] - c.a[1]) * h)) : h;
  const scale = Math.min(1, max / Math.max(sw, sh));
  return {
    sx,
    sy,
    sw,
    sh,
    dw: Math.max(1, Math.round(sw * scale)),
    dh: Math.max(1, Math.round(sh * scale)),
  };
}

/** The two barb end points of an arrow from `a` to `b`, at +-25 degrees from the shaft. */
export function arrowHead(a: Pt, b: Pt, len: number): [Pt, Pt] {
  const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const spread = (25 * Math.PI) / 180;
  const barb = (t: number): Pt => [b[0] + len * Math.cos(t), b[1] + len * Math.sin(t)];
  return [barb(back + spread), barb(back - spread)];
}

export function strokeWidth(dw: number, dh: number): number {
  return Math.max(4, Math.round(Math.max(dw, dh) * 0.004));
}
