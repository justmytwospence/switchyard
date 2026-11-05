import { type ComponentType, lazy } from "react";
import { flushAllDrafts } from "../drafts";

export const CHUNK_RELOAD_KEY = "sy:chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 10_000;

/** True (and records it) unless we already reloaded for a chunk error within the window. */
export function claimChunkReload(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  now: number,
): boolean {
  if (!storage) return false;
  const last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? 0);
  if (now - last < CHUNK_RELOAD_WINDOW_MS) return false;
  storage.setItem(CHUNK_RELOAD_KEY, String(now));
  return true;
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** React.lazy that reloads the page once when a route chunk fails (a deploy removed it). */
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      if (online && claimChunkReload(session(), Date.now())) {
        flushAllDrafts();
        window.location.reload();
        return new Promise<never>(() => {}); // keep the Suspense fallback until the reload
      }
      throw err; // Page's ErrorBoundary shows the fatal error
    }),
  );
}
