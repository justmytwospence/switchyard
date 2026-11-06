import type { Host, Session } from "@switchyard/protocol";
import { useCallback, useState } from "react";

export type Surface = "chat" | "terminal";

export function canUseTerminal(session: Session, host: Host | undefined): boolean {
  return (
    session.terminal === true &&
    host?.capabilities?.terminal === true &&
    host.connectivity === "connected"
  );
}

/** Per-session Chat/Terminal choice, kept in localStorage. */
export function useSessionSurface(sessionId: string): [Surface, (v: Surface) => void] {
  const key = `sy:surface:${sessionId}`;
  const read = (): Surface => {
    try {
      return localStorage.getItem(key) === "terminal" ? "terminal" : "chat";
    } catch {
      return "chat";
    }
  };
  const [value, setValue] = useState<Surface>(read);
  const set = useCallback(
    (v: Surface) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}
