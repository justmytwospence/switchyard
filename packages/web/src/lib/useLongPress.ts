import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";
import { SLOP } from "./gestures";
import { haptic } from "./haptics";

/** Stops the browser's own selection and link callout so a long-press can open our actions. */
export const LONG_PRESS_CLASS = "sy-pressable select-none [-webkit-touch-callout:none]";

const RECENT_MS = 800;
/** A hold starts to show (the element sinks) after this, so a quick tap never flickers. */
const FEEDBACK_MS = 120;

const block = (e: Event) => e.preventDefault();
let blockers = 0;
function blockSelection(): () => void {
  if (blockers++ === 0) document.addEventListener("selectstart", block, true);
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    if (--blockers === 0) document.removeEventListener("selectstart", block, true);
  };
}

/**
 * While a finger is down for a long-press, and until it lifts after the press fired, nothing may
 * start a text selection: iOS would select whatever ends up under the finger (often the sheet that
 * just opened). The click that ends the hold is swallowed too, so it cannot close that sheet.
 */
function guardUntilRelease(swallowClick: boolean): () => void {
  const unblock = blockSelection();
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", release, true);
    window.getSelection()?.removeAllRanges();
    // Selection can still start in the moment after the lift; keep the guard a little longer.
    window.setTimeout(unblock, 350);
    if (swallowClick) {
      const stop = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };
      document.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener("click", stop, true), 600);
    }
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  return release;
}

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onClickCapture: (e: MouseEvent) => void;
}

/**
 * Hold a finger on an element to run `onLongPress`. The element sinks slightly while held
 * (`data-pressing`, styled in styles.css), the tap that ends the hold is swallowed, and no text
 * selection or link callout starts.
 */
export function useLongPress(
  onLongPress: () => void,
  opts: { enabled?: boolean; delay?: number } = {},
): LongPressHandlers {
  const { enabled = true, delay = 420 } = opts;
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const timers = useRef<number[]>([]);
  const start = useRef<{ x: number; y: number; el: HTMLElement } | null>(null);
  const firedAt = useRef(0);
  const releaseGuard = useRef<(() => void) | null>(null);
  const clear = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    start.current?.el.removeAttribute("data-pressing");
    start.current = null;
  };
  const cancel = () => {
    clear();
    // Not fired: drop the selection guard at once.
    if (Date.now() - firedAt.current > RECENT_MS) {
      releaseGuard.current?.();
      releaseGuard.current = null;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear only touches refs
  useEffect(() => clear, []);
  const recent = () => Date.now() - firedAt.current < RECENT_MS;
  const fire = () => {
    firedAt.current = Date.now();
    haptic("medium");
    window.getSelection()?.removeAllRanges();
    cb.current();
  };
  if (!enabled) {
    const noop = () => undefined;
    return {
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
      onContextMenu: noop,
      onClickCapture: noop,
    };
  }
  return {
    onPointerDown(e) {
      if (!e.isPrimary || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
      clear();
      const el = e.currentTarget as HTMLElement;
      start.current = { x: e.clientX, y: e.clientY, el };
      releaseGuard.current?.();
      releaseGuard.current = guardUntilRelease(false);
      timers.current = [
        window.setTimeout(() => el.setAttribute("data-pressing", ""), FEEDBACK_MS),
        window.setTimeout(() => {
          clear();
          // The finger is still down: swallow the click its lift makes.
          releaseGuard.current?.();
          releaseGuard.current = guardUntilRelease(true);
          fire();
        }, delay),
      ];
    },
    onPointerMove(e) {
      const s = start.current;
      if (!s) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(e) {
      e.preventDefault();
      if (!recent()) fire();
    },
    onClickCapture(e) {
      if (recent()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
