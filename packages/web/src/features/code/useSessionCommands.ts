import type { SlashCommand } from "@switchyard/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { codeApi } from "./api";

const CACHE = new Map<string, { at: number; commands: SlashCommand[] }>();
const STALE_MS = 30_000;

/** Pi's slash commands for a session, cached for 30 s. */
export function useSessionCommands(
  sessionId: string,
  enabled: boolean,
): { commands: SlashCommand[]; loading: boolean; error: unknown; refresh: () => void } {
  const [commands, setCommands] = useState<SlashCommand[]>(CACHE.get(sessionId)?.commands ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (!enabled) return;
    const hit = CACHE.get(sessionId);
    if (hit) setCommands(hit.commands);
    if (hit && Date.now() - hit.at < STALE_MS) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    setError(null);
    codeApi
      .commands(sessionId, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        CACHE.set(sessionId, { at: Date.now(), commands: r.commands });
        setCommands(r.commands);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
  }, [sessionId, enabled]);

  useEffect(() => {
    load();
    return () => abort.current?.abort();
  }, [load]);

  return { commands, loading, error, refresh: load };
}
