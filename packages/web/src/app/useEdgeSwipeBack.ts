import { useEffect } from "react";
import { EDGE, edgeBackResult, lockAxis, velocity } from "../lib/gestures";
import { topBack } from "./chrome";

/**
 * Swipe from the left edge to go back, as in a native iOS app: the page follows the finger and
 * leaves. Only wanted where the system offers no back gesture of its own (an installed iOS app).
 */
export function useEdgeSwipeBack(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let track: {
      x: number;
      y: number;
      dx: number;
      axis: "x" | "y" | null;
      samples: { t: number; v: number }[];
    } | null = null;
    const main = () => document.getElementById("main");
    const clear = () => {
      const el = main();
      if (!el) return;
      el.style.transform = "";
      el.style.transition = "";
      el.style.boxShadow = "";
    };
    const animate = (to: string, done: () => void) => {
      const el = main();
      if (!el) return done();
      el.style.transition = "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      el.style.transform = to;
      window.setTimeout(done, 180);
    };
    const onStart = (e: TouchEvent) => {
      track = null;
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX > EDGE || !topBack()) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      track = { x: t.clientX, y: t.clientY, dx: 0, axis: null, samples: [] };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!track || !t) return;
      const dx = t.clientX - track.x;
      if (track.axis === null) {
        track.axis = lockAxis(dx, t.clientY - track.y);
        if (track.axis === null) return;
      }
      if (track.axis === "y" || dx <= 0) {
        if (track.axis === "y") track = null;
        return;
      }
      e.preventDefault();
      track.dx = dx;
      track.samples.push({ t: e.timeStamp, v: dx });
      track.samples = track.samples.slice(-12);
      const el = main();
      if (!el) return;
      el.style.transition = "none";
      el.style.transform = `translateX(${dx}px)`;
      el.style.boxShadow = "-8px 0 24px rgb(0 0 0 / 0.25)";
    };
    const onEnd = (e: TouchEvent) => {
      const d = track;
      track = null;
      if (d?.axis !== "x" || d.dx <= 0) return;
      if (e.type === "touchend" && edgeBackResult(d.dx, velocity(d.samples), window.innerWidth)) {
        animate("translateX(100vw)", () => {
          topBack()?.();
          requestAnimationFrame(() => requestAnimationFrame(clear));
        });
      } else animate("translateX(0)", clear);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      clear();
    };
  }, [enabled]);
}
