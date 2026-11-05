import type { View, ViewClient } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";

const EVERY_MS = 60_000;

/** Report this client as open in a view now and every minute; `stop()` withdraws it. */
export function startPresence(
  api: ApiClient,
  view: View,
  client: Omit<ViewClient, "lastSeenAt">,
  log: (line: string) => void,
): { stop(): Promise<void> } {
  const base = `/api/views/${encodeURIComponent(view.id)}/clients`;
  let lastError = "";
  const report = async () => {
    try {
      await api.post(base, client);
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
        await api.request("DELETE", `${base}/${encodeURIComponent(client.id)}`);
      } catch {
        // best effort
      }
    },
  };
}
