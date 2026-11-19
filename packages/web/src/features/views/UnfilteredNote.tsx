import { useSyncStore } from "../../sync/store";
import { useSelectedView } from "./selection";

/** On a page the selected view does not filter: say so while one is selected. */
export function UnfilteredNote({ what }: { what: string }) {
  const [selected] = useSelectedView();
  const view = useSyncStore((s) => (selected ? s.views[selected] : undefined));
  if (!view) return null;
  return (
    <p data-testid="unfiltered-note" className="text-xs text-subtle">
      Not filtered by the view: includes {what} outside {view.name}.
    </p>
  );
}
