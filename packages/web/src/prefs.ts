import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Per-device preferences persisted under `sy:prefs` (spec 10: filters,
 * selected project, pane sizes and last session persist per device).
 */

export const PANE_LIMITS = {
  navigator: { min: 220, max: 360, default: 264 },
  inspector: { min: 320, max: 600, default: 380 },
  boardColumn: { min: 288, max: 360, default: 320 },
} as const;

export type PaneName = keyof typeof PANE_LIMITS;

export interface Prefs {
  /** Selected project for Board/Code filters; null means all projects. */
  selectedProjectId: string | null;
  /** Last opened session (Code view reopens it). */
  lastSessionId: string | null;
  /** Project of the last session created with New session (prefills the next one). */
  lastNewSessionProjectId: string | null;
  paneSizes: Record<PaneName, number>;
  inspectorCollapsed: boolean;
  /** Rail labels expanded (desktop/compact). */
  railExpanded: boolean;
  /** Desktop composer: Enter sends, Shift+Enter inserts a newline. */
  sendWithEnter: boolean;
  /** Free-form per-view filter state, keyed by view (e.g. "board", "navigator"). */
  filters: Record<string, unknown>;
}

export interface PrefsStore extends Prefs {
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  setPaneSize(pane: PaneName, px: number): void;
  setFilter<T>(view: string, value: T): void;
}

export function clampPane(pane: PaneName, px: number): number {
  const l = PANE_LIMITS[pane];
  return Math.round(Math.min(l.max, Math.max(l.min, px)));
}

function defaultSendWithEnter(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  // Desktop (fine pointer, wide) defaults to Enter-to-send; touch devices use the Send button.
  return window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
}

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      lastSessionId: null,
      lastNewSessionProjectId: null,
      paneSizes: {
        navigator: PANE_LIMITS.navigator.default,
        inspector: PANE_LIMITS.inspector.default,
        boardColumn: PANE_LIMITS.boardColumn.default,
      },
      inspectorCollapsed: false,
      railExpanded: false,
      sendWithEnter: defaultSendWithEnter(),
      filters: {},
      set: (key, value) => set({ [key]: value } as Partial<Prefs>),
      setPaneSize: (pane, px) =>
        set((s) => ({ paneSizes: { ...s.paneSizes, [pane]: clampPane(pane, px) } })),
      setFilter: (view, value) => set((s) => ({ filters: { ...s.filters, [view]: value } })),
    }),
    {
      name: "sy:prefs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _s, setPaneSize: _p, setFilter: _f, ...prefs }) => prefs,
    },
  ),
);

/** Read a persisted filter for a view with a fallback. */
export function useFilter<T>(view: string, fallback: T): [T, (v: T) => void] {
  const value = usePrefs((s) => s.filters[view]) as T | undefined;
  const setFilter = usePrefs((s) => s.setFilter);
  return [value ?? fallback, (v: T) => setFilter(view, v)];
}
