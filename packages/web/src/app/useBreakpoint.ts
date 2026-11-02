import { useSyncExternalStore } from "react";

/** Spec 10: desktop >= 1200, compact 768-1199, mobile < 768. */
export type Breakpoint = "desktop" | "compact" | "mobile";

export const BREAKPOINTS = { compact: 768, desktop: 1200 } as const;

function current(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w >= BREAKPOINTS.desktop) return "desktop";
  if (w >= BREAKPOINTS.compact) return "compact";
  return "mobile";
}

function subscribe(cb: () => void): () => void {
  const queries = [
    window.matchMedia(`(min-width: ${BREAKPOINTS.compact}px)`),
    window.matchMedia(`(min-width: ${BREAKPOINTS.desktop}px)`),
  ];
  for (const q of queries) q.addEventListener("change", cb);
  return () => {
    for (const q of queries) q.removeEventListener("change", cb);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => "desktop");
}

/** True when the primary input is touch. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = window.matchMedia("(pointer: coarse)");
      q.addEventListener("change", cb);
      return () => q.removeEventListener("change", cb);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}
