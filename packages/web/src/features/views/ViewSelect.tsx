import type { View } from "@switchyard/protocol";
import { useId, useMemo } from "react";
import { Select } from "../../components/ui/Select";
import { cn } from "../../lib/cn";
import { useSyncStore } from "../../sync/store";
import { useTrackers } from "../../sync/trackers";
import { describeView, viewOptionLabel } from "./describe";
import { useSelectedView } from "./selection";

/** The views and the one-line description of a view, with trackers loaded when any view needs them. */
export function useViewDescriber(): {
  views: Record<string, View>;
  describe: (v: View, subject?: "sessions" | "tasks") => string;
} {
  const views = useSyncStore((s) => s.views);
  const projects = useSyncStore((s) => s.projects);
  const hosts = useSyncStore((s) => s.hosts);
  const trackerKey = useMemo(
    () =>
      Object.values(views)
        .map((v) => v.trackerId)
        .filter((id): id is string => !!id)
        .sort()
        .join(","),
    [views],
  );
  const { trackers } = useTrackers(trackerKey);
  return {
    views,
    describe: (v, subject) => describeView(v, { trackers, projects, hosts }, subject),
  };
}

/** Selects the view shared by Sessions and Board; "" is everything (`allLabel`). */
export function ViewSelect({
  allLabel,
  className,
  labelVisible,
  subject = "sessions",
}: {
  allLabel: string;
  className?: string;
  labelVisible?: boolean;
  /** What the page lists, for the description. */
  subject?: "sessions" | "tasks";
}) {
  const id = useId();
  const { views, describe } = useViewDescriber();
  const [selectedId, setSelectedId] = useSelectedView();
  const view = (selectedId ? views[selectedId] : null) ?? null;
  return (
    <div
      className={cn(
        labelVisible ? "flex min-w-0 flex-col gap-1" : "flex min-w-0 items-center gap-2",
        className,
      )}
    >
      <label htmlFor={id} className={labelVisible ? "text-sm font-medium" : "sr-only"}>
        View
      </label>
      <Select
        id={id}
        className={labelVisible ? "w-full" : "max-w-56"}
        value={view?.id ?? ""}
        title={view ? describe(view, subject) : undefined}
        onChange={(e) => setSelectedId(e.target.value || null)}
      >
        <option value="">{allLabel}</option>
        {Object.values(views).map((v) => (
          <option key={v.id} value={v.id}>
            {viewOptionLabel(v)}
          </option>
        ))}
      </Select>
      {labelVisible && view && <p className="text-xs text-muted">{describe(view, subject)}</p>}
    </div>
  );
}
