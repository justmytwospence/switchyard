import { useEffect, useRef } from "react";
import { create } from "zustand";

/** Shell chrome controlled by views (e.g. full-screen mobile detail hides the bottom nav). */
interface ChromeStore {
  hideBottomNav: number;
  /** Handlers for the edge-swipe back gesture; the last one registered is the top. */
  back: (() => void)[];
}

export const useChrome = create<ChromeStore>()(() => ({ hideBottomNav: 0, back: [] }));

/** Hide the mobile bottom nav while mounted (full-screen task detail, diff view). */
export function useHideBottomNav(active = true): void {
  useEffect(() => {
    if (!active) return;
    useChrome.setState((s) => ({ hideBottomNav: s.hideBottomNav + 1 }));
    return () => useChrome.setState((s) => ({ hideBottomNav: s.hideBottomNav - 1 }));
  }, [active]);
}

/** Make the edge-swipe back gesture (installed iOS app) run `handler` while this view is mounted. */
export function useSwipeBack(handler: (() => void) | null): void {
  const latest = useRef(handler);
  latest.current = handler;
  const active = handler !== null;
  useEffect(() => {
    if (!active) return;
    const wrapper = () => latest.current?.();
    useChrome.setState((s) => ({ back: [...s.back, wrapper] }));
    return () => useChrome.setState((s) => ({ back: s.back.filter((b) => b !== wrapper) }));
  }, [active]);
}

/** The handler of the topmost view that registered one. */
export function topBack(): (() => void) | null {
  const { back } = useChrome.getState();
  return back[back.length - 1] ?? null;
}
