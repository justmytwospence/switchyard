/** Pure thresholds and maths for touch gestures (swipe rows, swipe tabs, sheets, edge back). */

export const SLOP = 10;
export const EDGE = 24;
/** Width of one revealed swipe action. */
export const REVEAL = 76;

export type Axis = "x" | "y" | null;

/** Which way a drag is going once it has moved past the slop. */
export function lockAxis(dx: number, dy: number, slop = SLOP): Axis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
}

/** Resistance past an edge: grows with `over` but never reaches `dim`. */
export function rubberBand(over: number, dim: number): number {
  if (over === 0 || dim <= 0) return 0;
  const a = Math.abs(over);
  return Math.sign(over) * (1 - 1 / ((a * 0.55) / dim + 1)) * dim;
}

export type SwipeSide = "leading" | "trailing";
export type SwipeResult = { kind: "close" } | { kind: "open" | "commit"; side: SwipeSide };

/**
 * What a released row swipe does. `offset > 0` reveals the leading actions, `< 0` the trailing
 * ones; `reveal` is the width of each side's revealed buttons (0 without actions).
 */
export function swipeResult(
  offset: number,
  velocity: number,
  o: {
    width: number;
    reveal: { leading: number; trailing: number };
    fullSwipe: { leading: boolean; trailing: boolean };
  },
): SwipeResult {
  if (offset === 0) return { kind: "close" };
  const side: SwipeSide = offset > 0 ? "leading" : "trailing";
  const reveal = o.reveal[side];
  if (reveal <= 0) return { kind: "close" };
  const dist = Math.abs(offset);
  // Velocity in the direction of the reveal.
  const v = offset > 0 ? velocity : -velocity;
  if (o.fullSwipe[side] && (dist >= fullSwipeAt(o.width, reveal) || (dist >= reveal && v > 1.2))) {
    return { kind: "commit", side };
  }
  if (v < -0.3) return { kind: "close" };
  if (dist >= reveal / 2 || v > 0.3) return { kind: "open", side };
  return { kind: "close" };
}

/** How far a row must be dragged for a full swipe. */
export function fullSwipeAt(width: number, reveal: number): number {
  return Math.max(width * 0.55, reveal + 48);
}

/** A bottom sheet dragged down far or fast enough closes. */
export function dismissResult(dy: number, vy: number, height: number): boolean {
  return dy > 0.25 * height || (dy > 40 && vy > 0.5);
}

/** -1 previous, 1 next, 0 stay. */
export function pageResult(dx: number, vx: number, width: number): -1 | 0 | 1 {
  if (dx < -0.25 * width || (dx < -40 && vx < -0.4)) return 1;
  if (dx > 0.25 * width || (dx > 40 && vx > 0.4)) return -1;
  return 0;
}

export function edgeBackResult(dx: number, vx: number, width: number): boolean {
  return dx > 0.35 * width || (dx > 60 && vx > 0.5);
}

/** px/ms over the samples of the last 100 ms. */
export function velocity(samples: { t: number; v: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const recent = samples.filter((s) => last.t - s.t <= 100);
  const first = recent[0]!;
  const dt = last.t - first.t;
  if (recent.length < 2 || dt <= 0) return 0;
  return (last.v - first.v) / dt;
}
