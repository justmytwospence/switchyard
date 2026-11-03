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
    // Per-session state first: never show another session's commands, loading flag or error.
    const hit = CACHE.get(sessionId);
    setCommands(hit?.commands ?? []);
    setError(null);
    setLoading(false);
    abort.current?.abort();
    if (!enabled) return;
    if (hit && Date.now() - hit.at < STALE_MS) return;
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
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
