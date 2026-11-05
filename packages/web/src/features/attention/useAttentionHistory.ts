import type { AttentionItem } from "@switchyard/protocol";
import { useEffect, useRef } from "react";
import { type Resource, useResource } from "../../lib/useResource";
import { apiGet } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

export const HISTORY_LIMIT = 200;

/**
 * Resolved attention items, newest first. The sync store drops resolved items, so they come
 * from the API; refetched when open attention changes (debounced) and every 30 s.
 */
export function useAttentionHistory(enabled: boolean): Resource<AttentionItem[]> {
  const res = useResource<AttentionItem[]>(
    enabled ? "attention-history" : null,
    (signal) =>
      apiGet<AttentionItem[]>(
        "/api/attention",
        { resolvedOnly: "true", limit: HISTORY_LIMIT },
        signal,
      ),
    { refreshMs: 30_000, check: Array.isArray },
  );
  const attention = useSyncStore((s) => s.attention);
  const first = useRef(true);
  const { reload } = res;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on attention changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled) return;
    const t = setTimeout(reload, 500);
    return () => clearTimeout(t);
  }, [attention, enabled, reload]);
  return res;
}
