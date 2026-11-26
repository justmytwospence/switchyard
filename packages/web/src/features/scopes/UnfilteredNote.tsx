import { useSyncStore } from "../../sync/store";
import { useSelectedScope } from "./selection";

/** On a page the selected scope does not filter: say so while one is selected. */
export function UnfilteredNote({ what }: { what: string }) {
  const [selected] = useSelectedScope();
  const scope = useSyncStore((s) => (selected ? s.scopes[selected] : undefined));
  if (!scope) return null;
  return (
    <p data-testid="unfiltered-note" className="text-xs text-subtle">
      Not filtered by the scope: includes {what} outside {scope.name}.
    </p>
  );
}
