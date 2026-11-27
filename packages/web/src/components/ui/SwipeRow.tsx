import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  fullSwipeAt,
  lockAxis,
  REVEAL,
  rubberBand,
  type SwipeSide,
  swipeResult,
  velocity,
} from "../../lib/gestures";
import { haptic } from "../../lib/haptics";

export interface SwipeAction {
  id: string;
  label: string;
  icon: ReactNode;
  tone: "red" | "orange" | "blue" | "gray" | "green";
  onAction: () => unknown;
  /** The row leaves the list when this succeeds: it slides out, and back if the action fails. */
  removes?: boolean;
}

/** Saturated, theme-independent colours, as in native swipe actions. */
const TONE: Record<SwipeAction["tone"], string> = {
  red: "bg-[#e5484d] text-white",
  orange: "bg-[#f76b15] text-white",
  blue: "bg-[#0090ff] text-white",
  gray: "bg-[#6e7681] text-white",
  green: "bg-[#30a46c] text-white",
};

const SETTLE = "transform 260ms cubic-bezier(0.2, 0.9, 0.25, 1)";
const SKIP = "input, textarea, select, [contenteditable], [data-no-swipe]";

let closeOpenRow: (() => void) | null = null;

interface Drag {
  id: number;
  x: number;
  y: number;
  axis: "x" | "y" | null;
  start: number;
  raw: number;
  full: boolean;
  samples: { t: number; v: number }[];
}

/**
 * A row that reveals actions when dragged sideways (touch and pen only), like a native list:
 * `leading` actions sit under the left edge, `trailing` under the right. The first action of a
 * side is the outermost one; a long swipe runs it, a shorter one leaves the buttons open.
 */
export function SwipeRow({
  leading = [],
  trailing = [],
  disabled,
  children,
  className,
  contentClassName,
}: {
  leading?: SwipeAction[];
  trailing?: SwipeAction[];
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const fg = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  // The row's offset drives the action layer; the foreground moves through its style directly.
  const [offset, setOffset] = useState(0);
  const [full, setFull] = useState(false);
  const offsetRef = useRef(0);
  const actions = useRef({ leading, trailing });
  actions.current = { leading, trailing };
  const active = !disabled && (leading.length > 0 || trailing.length > 0);

  const width = () => fg.current?.offsetWidth || 320;
  const place = (to: number, animate: boolean) => {
    const el = fg.current;
    if (el) {
      el.style.transition = animate ? SETTLE : "none";
      el.style.transform = to === 0 ? "" : `translateX(${to}px)`;
    }
    offsetRef.current = to;
    setOffset(to);
  };
  const closeRef = useRef(() => {});
  closeRef.current = () => {
    place(0, true);
    setFull(false);
    if (closeOpenRow === stableClose) closeOpenRow = null;
  };
  const [stableClose] = useState(() => () => closeRef.current());

  const run = async (action: SwipeAction, side: SwipeSide) => {
    haptic();
    if (action.removes) {
      const w = width();
      setFull(true);
      place(side === "leading" ? w : -w, true);
      try {
        await action.onAction();
      } catch {
        closeRef.current();
        return;
      }
      // Close the gap it leaves; the list drops the row when the change arrives.
      const row = fg.current?.parentElement;
      if (row && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        row.animate?.([{ height: `${row.offsetHeight}px` }, { height: "0px" }], {
          duration: 220,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          fill: "forwards",
        });
      }
      return;
    }
    closeRef.current();
    await action.onAction();
  };

  // While a row is open, a touch anywhere else closes it.
  const isOpen = offset !== 0;
  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (fg.current?.parentElement?.contains(e.target as Node)) return;
      if (!drag.current) closeRef.current();
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [isOpen]);
  useEffect(
    () => () => {
      if (closeOpenRow === stableClose) closeOpenRow = null;
    },
    [stableClose],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !e.isPrimary || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    if ((e.target as HTMLElement).closest(SKIP)) return;
    dragged.current = false;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      axis: null,
      start: offsetRef.current,
      raw: offsetRef.current,
      full: false,
      samples: [],
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
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
      dragged.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      if (closeOpenRow && closeOpenRow !== stableClose) closeOpenRow();
    }
    const { leading: l, trailing: t } = actions.current;
    const w = width();
    let raw = d.start + dx;
    // A side without actions resists, like the end of a list.
    if (raw > 0 && l.length === 0) raw = rubberBand(raw, w) * 0.15;
    if (raw < 0 && t.length === 0) raw = rubberBand(raw, w) * 0.15;
    d.raw = raw;
    d.samples.push({ t: e.timeStamp, v: raw });
    d.samples = d.samples.slice(-12);
    const reveal = (raw > 0 ? l.length : t.length) * REVEAL;
    const isFull = reveal > 0 && Math.abs(raw) >= fullSwipeAt(w, reveal);
    if (isFull !== d.full) {
      d.full = isFull;
      setFull(isFull);
      haptic();
    }
    place(raw, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.axis !== "x") return;
    const { leading: l, trailing: t } = actions.current;
    if (e.type === "pointercancel") return closeRef.current();
    const res = swipeResult(d.raw, velocity(d.samples), {
      width: width(),
      reveal: { leading: l.length * REVEAL, trailing: t.length * REVEAL },
      fullSwipe: { leading: true, trailing: true },
    });
    if (res.kind === "close") return closeRef.current();
    const list = res.side === "leading" ? l : t;
    const outer = list[0];
    if (!outer) return closeRef.current();
    if (res.kind === "commit") return void run(outer, res.side);
    setFull(false);
    place((res.side === "leading" ? 1 : -1) * list.length * REVEAL, true);
    closeOpenRow = stableClose;
  };

  const side: SwipeSide = offset > 0 ? "leading" : "trailing";
  const list = offset > 0 ? leading : trailing;
  // Outermost first: on the right the first action is rightmost, so lay them out reversed.
  const shown = side === "trailing" ? [...list].reverse() : list;
  return (
    <div className={cn("relative overflow-hidden", className)} data-swipe-row>
      {offset !== 0 && list.length > 0 && (
        <div
          aria-hidden
          className={cn("absolute inset-y-0 flex", side === "leading" ? "left-0" : "right-0")}
          style={{ width: Math.abs(offset) }}
        >
          {shown.map((a) => {
            const outer = a === list[0];
            return (
              <button
                key={a.id}
                type="button"
                tabIndex={-1}
                data-swipe-action={a.id}
                onClick={() => void run(a, side)}
                style={{ flexGrow: full ? (outer ? 1 : 0) : 1, flexBasis: 0 }}
                className={cn(
                  "flex min-w-0 flex-col items-center justify-center gap-1 overflow-hidden text-xs font-semibold whitespace-nowrap transition-[flex-grow] duration-200",
                  TONE[a.tone],
                  full && outer && (side === "leading" ? "items-start pl-6" : "items-end pr-6"),
                )}
              >
                {a.icon}
                {a.label}
              </button>
            );
          })}
        </div>
      )}
      <div
        ref={fg}
        className={cn("relative touch-pan-y bg-surface", contentClassName)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          if (dragged.current) {
            dragged.current = false;
            e.preventDefault();
            e.stopPropagation();
          } else if (offsetRef.current !== 0) {
            e.preventDefault();
            e.stopPropagation();
            closeRef.current();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
