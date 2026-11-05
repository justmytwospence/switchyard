import type { NowResponse } from "@switchyard/protocol";
import { useEffect, useRef } from "react";
import { type Resource, useResource } from "../../lib/useResource";
import { apiGet } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

/**
 * GET /api/now: running runs, queued Ready tasks with their wait reason and
 * the dispatch-paused flag. Refetches when tasks/runs change (debounced) and
 * every 15 s while visible.
 */
export function useNow(enabled = true): Resource<NowResponse> {
  const res = useResource<NowResponse>(
    enabled ? "now" : null,
    (signal) => apiGet<NowResponse>("/api/now", undefined, signal),
    { refreshMs: 15_000 },
  );
  const tasks = useSyncStore((s) => s.tasks);
  const runs = useSyncStore((s) => s.runs);
  const paused = useSyncStore((s) => s.dispatchPaused);
  const first = useRef(true);
  const { reload } = res;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on entity changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled) return;
    const t = setTimeout(reload, 500);
    return () => clearTimeout(t);
  }, [tasks, runs, paused, enabled, reload]);
  return res;
}
