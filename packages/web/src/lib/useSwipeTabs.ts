import {
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EDGE, lockAxis, pageResult, rubberBand, velocity } from "./gestures";
import { haptic } from "./haptics";
import { createSwipeProgress, type SwipeProgress } from "./swipeProgress";

/** Drags that start here belong to the element (fields, swipeable rows, opt-outs). */
const IGNORE = "input, textarea, select, [contenteditable], [data-no-swipe], [data-swipe-row]";

/** Whether a drag from `el` would scroll something sideways inside `root` (code, diffs, tabs). */
function inHorizontalScroller(el: HTMLElement | null, root: HTMLElement): boolean {
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const o = getComputedStyle(n).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
  }
  return false;
}

export interface SwipeTabs {
  /** Spread on the element that takes the swipe (give it `touch-pan-y`). */
  bind: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: (e: PointerEvent) => void;
    onPointerCancel: (e: PointerEvent) => void;
    onClickCapture: (e: MouseEvent) => void;
  };
  /** The content that follows the finger and slides in when the tab changes. */
  innerRef: RefObject<HTMLDivElement | null>;
  /** Pass to the tab strip so its indicator follows the finger. */
  progress: SwipeProgress;
}

/**
 * Swipe sideways to move to the neighbouring tab (touch and pen only). The content follows the
 * finger, resists at the first and last tab, and slides in from the side it came from; a tap on
 * a tab slides the same way.
 */
export function useSwipeTabs(
  ids: string[],
  value: string,
  onChange: (id: string) => void,
  enabled = true,
  /** Swiping right on the first tab runs this (e.g. back to the list), instead of resisting. */
  onBeforeFirst?: () => void,
): SwipeTabs {
  const innerRef = useRef<HTMLDivElement>(null);
  const [progress] = useState(createSwipeProgress);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    dx: number;
    axis: "x" | "y" | null;
    samples: { t: number; v: number }[];
  } | null>(null);
  const swallow = useRef(false);
  const prev = useRef(value);
  const idx = ids.indexOf(value);
  const on = enabled && ids.length >= 2 && idx >= 0;

  // Slide the new tab in from the side it came from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of tab animates
  useLayoutEffect(() => {
    const from = ids.indexOf(prev.current);
    prev.current = value;
    const el = innerRef.current;
    if (!el || from < 0 || idx < 0 || from === idx) return;
    el.style.transition = "";
    el.style.transform = "";
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const dir = idx > from ? 1 : -1;
    el.animate?.(
      [
        { transform: `translateX(${dir * 40}px)`, opacity: 0.3 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)" },
    );
  }, [value]);

  const settle = () => {
    const el = innerRef.current;
    if (!el) return;
    el.style.transition = "transform 220ms cubic-bezier(0.2, 0.9, 0.25, 1)";
    el.style.transform = "";
  };

  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.axis !== "x") return;
    progress.emit(null);
    swallow.current = true;
    window.setTimeout(() => {
      swallow.current = false;
    }, 50);
    const width = (e.currentTarget as HTMLElement).offsetWidth || 320;
    const step = e.type === "pointercancel" ? 0 : pageResult(d.dx, velocity(d.samples), width);
    const next = ids[idx + step];
    if (step === -1 && idx === 0 && onBeforeFirst) {
      const el = innerRef.current;
      haptic();
      if (el) {
        el.style.transition = "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = `translateX(${width}px)`;
      }
      window.setTimeout(() => {
        onBeforeFirst();
        if (el) {
          el.style.transition = "none";
          el.style.transform = "";
        }
      }, 180);
    } else if (step !== 0 && next !== undefined) {
      const el = innerRef.current;
      if (el) {
        el.style.transition = "none";
        el.style.transform = "";
      }
      haptic();
      onChange(next);
    } else settle();
  };

  return {
    innerRef,
    progress,
    bind: {
      onPointerUp: up,
      onPointerCancel: up,
      onPointerDown(e) {
        drag.current = null;
        if (!on || !e.isPrimary || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
        // The left edge belongs to the system's (or our installed app's) back gesture.
        if (e.clientX <= EDGE) return;
        const target = e.target as HTMLElement;
        if (target.closest(IGNORE)) return;
        if (inHorizontalScroller(target, e.currentTarget as HTMLElement)) return;
        drag.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          dx: 0,
          axis: null,
          samples: [],
        };
      },
      onPointerMove(e) {
        const d = drag.current;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x;
        if (d.axis === null) {
          d.axis = lockAxis(dx, e.clientY - d.y);
          if (d.axis === null) return;
          if (d.axis === "y") {
            drag.current = null;
            return;
          }
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }
        d.dx = dx;
        d.samples.push({ t: e.timeStamp, v: dx });
        d.samples = d.samples.slice(-12);
        const el = innerRef.current;
        if (!el) return;
        const hasNeighbor = dx < 0 ? idx < ids.length - 1 : idx > 0 || !!onBeforeFirst;
        const shown = hasNeighbor ? dx : rubberBand(dx, el.offsetWidth || 320) * 0.4;
        el.style.transition = "none";
        el.style.transform = `translateX(${shown}px)`;
        if (hasNeighbor) progress.emit(-dx / (el.offsetWidth || 320));
      },
      onClickCapture(e) {
        if (swallow.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    },
  };
}
