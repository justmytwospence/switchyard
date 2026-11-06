import { saveTranscriptCache } from "./cache";
import { useSyncStore } from "./store";

const DEBOUNCE_MS = 2000;
const KEEP_ITEMS = 500;

/** Save each loaded, server-confirmed transcript to the offline cache, throttled per session. */
export function startTranscriptPersistence(): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = useSyncStore.subscribe((s, prev) => {
    for (const [id, t] of Object.entries(s.transcripts)) {
      if (t === prev.transcripts[id]) continue;
      if (!t.loaded || t.stale || t.epoch === null || t.rev === null) continue;
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const cur = useSyncStore.getState().transcripts[id];
          if (!cur || !cur.loaded || cur.stale || cur.epoch === null || cur.rev === null) return;
          void saveTranscriptCache({
            sessionId: id,
            epoch: cur.epoch,
            rev: cur.rev,
            items: cur.items.slice(-KEEP_ITEMS),
            hasMore: cur.hasMore || cur.items.length > KEEP_ITEMS,
            savedAt: new Date().toISOString(),
          });
        }, DEBOUNCE_MS),
      );
    }
  });
  return () => {
    unsubscribe();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
