import { useFilter } from "../../prefs";

/** The selected view (null: everything); persisted per browser, shared by Sessions and Board. */
export function useSelectedView(): [string | null, (id: string | null) => void] {
  return useFilter<string | null>("codeView", null);
}
