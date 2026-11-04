import { useEffect, useRef, useState } from "react";

/** Time to catch up with whatever has arrived, whatever the burst size. */
const CATCH_UP_MS = 160;
/** Floor on reveal speed, so a slow trickle still moves (chars per second). */
const MIN_RATE = 60;

/** Reveal speed (chars per second) that clears `backlog` in about CATCH_UP_MS. */
export function revealRate(backlog: number): number {
  return Math.max(MIN_RATE, (backlog * 1000) / CATCH_UP_MS);
}

/** Characters shown after `dtMs` at `rate`, at least one per frame, never past the target. */
export function nextShownLength(shown: number, target: number, dtMs: number, rate: number): number {
  if (shown >= target) return target;
  return Math.min(target, shown + Math.max(1, Math.round((rate * dtMs) / 1000)));
}

/**
 * Streamed text revealed smoothly while `live`; the full text at once otherwise (and always
 * with reduced motion).
 */
export function useSmoothText(text: string, live: boolean): string {
  const calm =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const smooth = live && !calm;
  const shownRef = useRef(smooth ? 0 : text.length);
  const rateRef = useRef(0);
  const [shown, setShown] = useState(shownRef.current);

  useEffect(() => {
    if (!smooth) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    if (shownRef.current > text.length) shownRef.current = text.length;
    // Hold one speed per burst so it drains evenly, speeding up when more arrives meanwhile.
    rateRef.current = Math.max(rateRef.current, revealRate(text.length - shownRef.current));
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = nextShownLength(shownRef.current, text.length, now - last, rateRef.current);
      last = now;
      if (next !== shownRef.current) {
        shownRef.current = next;
        setShown(next);
      }
      if (next < text.length) frame = requestAnimationFrame(tick);
      else rateRef.current = 0;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, smooth]);

  return smooth ? text.slice(0, Math.min(shown, text.length)) : text;
}
