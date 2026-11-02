import { useEffect } from "react";
import { create } from "zustand";

/** Shell chrome controlled by views (e.g. full-screen mobile detail hides the bottom nav). */
interface ChromeStore {
  hideBottomNav: number;
}

export const useChrome = create<ChromeStore>()(() => ({ hideBottomNav: 0 }));

/** Hide the mobile bottom nav while mounted (full-screen task detail, diff view). */
export function useHideBottomNav(active = true): void {
  useEffect(() => {
    if (!active) return;
    useChrome.setState((s) => ({ hideBottomNav: s.hideBottomNav + 1 }));
    return () => useChrome.setState((s) => ({ hideBottomNav: s.hideBottomNav - 1 }));
  }, [active]);
}
