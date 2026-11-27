/**
 * How far a swipe between tabs has gone: a fraction toward the next tab (positive) or the
 * previous one (negative), or null when the finger lifts. Tab strips listen to it so their
 * indicator follows the finger, without re-rendering on every move.
 */
export interface SwipeProgress {
  listen(cb: (fraction: number | null) => void): () => void;
  emit(fraction: number | null): void;
}

export function createSwipeProgress(): SwipeProgress {
  const listeners = new Set<(f: number | null) => void>();
  return {
    listen(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(f) {
      for (const cb of listeners) cb(f);
    },
  };
}
