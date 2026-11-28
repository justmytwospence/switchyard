import { useFilter, usePrefs } from "../../prefs";

export function currentScopeId(): string | null {
  const value = usePrefs.getState().filters.codeView;
  return typeof value === "string" ? value : null;
}

/** The selected scope (null: everything); persisted per browser, shared by Sessions and Board. */
export function useSelectedScope(): [string | null, (id: string | null) => void] {
  return useFilter<string | null>("codeView", null);
}
