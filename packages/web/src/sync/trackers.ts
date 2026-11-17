import type { Tracker } from "@switchyard/protocol";
import { useEffect } from "react";
import { create } from "zustand";
import { apiGet } from "./api";

/** Trackers are REST resources (not in the sync stream): loaded on first use. */
interface TrackersStore {
  /** null: not loaded yet. */
  trackers: Tracker[] | null;
  loading: boolean;
  /** The last load error, cleared on success. */
  error: unknown;
  load(): Promise<void>;
  upsert(t: Tracker): void;
  remove(id: string): void;
}

let inflight: Promise<void> | null = null;
/** The refresh key the last load ran for. */
let loadedKey: string | null = null;

export const useTrackersStore = create<TrackersStore>()((set, get) => ({
  trackers: null,
  loading: false,
  error: null,
  load() {
    inflight ??= (async () => {
      set({ loading: true });
      try {
        const trackers = await apiGet<Tracker[]>("/api/trackers");
        set({ trackers, error: null });
      } catch (error) {
        set({ error });
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    return inflight;
  },
  upsert(t) {
    const cur = get().trackers;
    if (cur === null) return;
    set({
      trackers: cur.some((x) => x.id === t.id)
        ? cur.map((x) => (x.id === t.id ? t : x))
        : [...cur, t],
    });
  },
  remove(id) {
    const cur = get().trackers;
    if (cur !== null) set({ trackers: cur.filter((x) => x.id !== id) });
  },
}));

/** Trackers, loaded on first use and again whenever `refreshKey` changes. */
export function useTrackers(refreshKey = "") {
  const trackers = useTrackersStore((s) => s.trackers);
  const loading = useTrackersStore((s) => s.loading);
  const error = useTrackersStore((s) => s.error);
  const load = useTrackersStore((s) => s.load);
  useEffect(() => {
    const s = useTrackersStore.getState();
    if (s.loading) return;
    const first = s.trackers === null && s.error === null;
    if (!first && loadedKey === refreshKey) return;
    if (s.trackers === null && s.error !== null) return;
    loadedKey = refreshKey;
    void load();
  }, [refreshKey, load]);
  return { trackers, loading, error, reload: () => void load() };
}
