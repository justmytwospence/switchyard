import { type RefObject, useEffect, useRef } from "react";
import { dismissResult, lockAxis, rubberBand, velocity } from "./gestures";

const FORM = "input, textarea, select, [contenteditable], [data-no-sheet-drag]";

/**
 * Drag a bottom sheet down to close it, from anywhere on it: from its body only while that body
 * is scrolled to the top (`[data-sheet-scroll]`), as in native sheets. Uses touch events so the
 * drag can take over from the body's own scrolling.
 */
export function useDragDismiss(
  panel: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDismiss: () => void,
): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const el = panel.current;
    if (!enabled || !el) return;
    let t: {
      x: number;
      y: number;
      axis: "x" | "y" | null;
      dragging: boolean;
      scroller: HTMLElement | null;
      dy: number;
      samples: { t: number; v: number }[];
    } | null = null;
    const settle = (to: string, ms: number, done?: () => void) => {
      el.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = to;
      window.setTimeout(() => {
        if (!done) {
          el.style.transition = "";
          el.style.transform = "";
        }
        done?.();
      }, ms);
    };
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      const target = e.target as HTMLElement;
      if (e.touches.length !== 1 || !touch || target.closest(FORM)) {
        t = null;
        return;
      }
      t = {
        x: touch.clientX,
        y: touch.clientY,
        axis: null,
        dragging: false,
        scroller: target.closest<HTMLElement>("[data-sheet-scroll]"),
        dy: 0,
        samples: [],
      };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!t || !touch) return;
      const dy = touch.clientY - t.y;
      if (t.axis === null) {
        t.axis = lockAxis(touch.clientX - t.x, dy);
        if (t.axis === null) return;
      }
      if (t.axis === "x") return;
      if (!t.dragging) {
        // Pulling down at the top of the body (or on the header) moves the sheet; else it scrolls.
        if (dy <= 0 || (t.scroller && t.scroller.scrollTop > 0)) {
          t = null;
          return;
        }
        t.dragging = true;
        t.y = touch.clientY;
      }
      e.preventDefault();
      const d = touch.clientY - t.y;
      t.dy = d;
      t.samples.push({ t: e.timeStamp, v: d });
      t.samples = t.samples.slice(-12);
      el.style.transition = "none";
      el.style.transform = `translateY(${d > 0 ? d : rubberBand(d, 120)}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const d = t;
      t = null;
      if (!d?.dragging) return;
      if (e.type === "touchend" && dismissResult(d.dy, velocity(d.samples), el.offsetHeight)) {
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) dismiss.current();
        else settle("translateY(100%)", 200, () => dismiss.current());
      } else settle("translateY(0)", 220);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, panel]);
}
