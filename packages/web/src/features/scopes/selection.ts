import { useFilter, usePrefs } from "../../prefs";
import { useSyncStore } from "../../sync/store";

function effectiveScopeId(value: unknown, state: ReturnType<typeof useSyncStore.getState>) {
  return typeof value === "string" && (!state.hydrated || state.scopes[value]) ? value : null;
}

export function currentScopeId(): string | null {
  return effectiveScopeId(usePrefs.getState().filters.codeView, useSyncStore.getState());
}

/** The selected scope (null: everything); persisted per browser, shared by Sessions and Board. */
export function useSelectedScope(): [string | null, (id: string | null) => void] {
  const [stored, set] = useFilter<string | null>("codeView", null);
  // Removing a saved scope returns to All work, including in the explicit-start guard.
  const selected = useSyncStore((state) => effectiveScopeId(stored, state));
  return [selected, set];
}
