import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { SwipeProgress } from "../../lib/swipeProgress";

const EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";

/**
 * A selection indicator (a tab underline, a segmented control's thumb) that slides between the
 * items of `list` marked `data-indicator-key`, and follows a swipe's `progress` live.
 */
export function useIndicator(
  list: RefObject<HTMLElement | null>,
  value: string,
  progress?: SwipeProgress,
): RefObject<HTMLSpanElement | null> {
  const indicator = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const items = () =>
    [...(list.current?.querySelectorAll<HTMLElement>("[data-indicator-key]") ?? [])].filter(
      (el) => el.closest("[data-indicator-root]") === list.current,
    );
  const place = (x: number, w: number, animate: boolean) => {
    const el = indicator.current;
    if (!el) return;
    el.style.transition = animate ? `transform 260ms ${EASE}, width 260ms ${EASE}` : "none";
    el.style.transform = `translateX(${x}px)`;
    el.style.width = `${w}px`;
    el.style.opacity = w > 0 ? "1" : "0";
  };
  const toSelected = (animate: boolean) => {
    const sel = items().find((el) => el.dataset.indicatorKey === valueRef.current);
    if (!sel) return place(0, 0, false);
    place(sel.offsetLeft, sel.offsetWidth, animate && placed.current);
    placed.current = true;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: placement follows the selection
  useLayoutEffect(() => toSelected(true), [value]);

  // Labels and counts change width; the list resizes with the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: observers read the latest value
  useEffect(() => {
    const root = list.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => toSelected(false));
    ro.observe(root);
    for (const el of items()) ro.observe(el);
    return () => ro.disconnect();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once per progress channel
  useEffect(() => {
    if (!progress) return;
    return progress.listen((f) => {
      if (f === null) return toSelected(true);
      const all = items();
      const i = all.findIndex((el) => el.dataset.indicatorKey === valueRef.current);
      const cur = all[i];
      const next = all[i + (f > 0 ? 1 : -1)];
      if (!cur || !next) return;
      const t = Math.min(1, Math.abs(f));
      place(
        cur.offsetLeft + (next.offsetLeft - cur.offsetLeft) * t,
        cur.offsetWidth + (next.offsetWidth - cur.offsetWidth) * t,
        false,
      );
    });
  }, [progress]);

  return indicator;
}
