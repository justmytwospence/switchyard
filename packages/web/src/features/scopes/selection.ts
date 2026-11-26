import { useFilter } from "../../prefs";

/** The selected scope (null: everything); persisted per browser, shared by Sessions and Board. */
export function useSelectedScope(): [string | null, (id: string | null) => void] {
  return useFilter<string | null>("codeView", null);
}
