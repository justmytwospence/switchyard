import { useFilter } from "../../prefs";

/** The view selected in the navigator (null: all sessions); persisted per browser. */
export function useSelectedView(): [string | null, (id: string | null) => void] {
  return useFilter<string | null>("codeView", null);
}
