import type { SurfaceKind } from "@switchyard/protocol";
import { type ApiClient, ApiRequestError } from "@switchyard/terminal";

const EVERY_MS = 60_000;

/** A herdr or tmux session as a Switchyard surface. */
export interface SurfaceInfo {
  /** `${kind}:${name}@${machine}` */
  id: string;
  kind: SurfaceKind;
  name: string;
  machine: string;
  /** The host agent on this machine, when it is enrolled with the same coordinator. */
  hostId: string | null;
}

/** An older coordinator has no surface routes (an unknown route, not a missing view). */
function noSurfaceRoutes(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404 && !/^View /.test(err.message);
}

/**
 * Report this surface as showing a view now and every minute; `stop()` withdraws it. Against an
 * older coordinator it falls back to the legacy view client endpoints.
 */
export function startPresence(
  api: ApiClient,
  surface: SurfaceInfo,
  viewId: string,
  log: (line: string) => void,
): { stop(): Promise<void> } {
  const path = `/api/surfaces/${encodeURIComponent(surface.id)}`;
  const legacy = `/api/views/${encodeURIComponent(viewId)}/clients`;
  let useLegacy = false;
  let lastError = "";
  const report = async () => {
    try {
      if (useLegacy) {
        const { id, kind, name, machine } = surface;
        await api.post(legacy, { id, kind, name, machine });
      } else {
        try {
          const { kind, name, machine, hostId } = surface;
          await api.request("PUT", path, { kind, name, machine, viewId, hostId });
        } catch (err) {
          if (!noSurfaceRoutes(err)) throw err;
          useLegacy = true;
          const { id, kind, name, machine } = surface;
          await api.post(legacy, { id, kind, name, machine });
        }
      }
      lastError = "";
    } catch (err) {
      const m = (err as Error).message;
      if (m !== lastError) log(`presence report failed: ${m}`);
      lastError = m;
    }
  };
  void report();
  const timer = setInterval(() => void report(), EVERY_MS);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      try {
        if (useLegacy) await api.request("DELETE", `${legacy}/${encodeURIComponent(surface.id)}`);
        else await api.request("DELETE", path);
      } catch {
        // best effort
      }
    },
  };
}
