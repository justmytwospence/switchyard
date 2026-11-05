import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";

/** A dismissed or aborted passkey prompt. */
export function isCanceledCeremony(err: unknown): boolean {
  return err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
}

/**
 * Runs a WebAuthn ceremony the user can cancel at once. Some authenticator UIs never reject when
 * their popup closes, so Cancel does not wait for the browser: it resets and ignores the late result.
 */
export function usePasskeyCeremony() {
  const [waiting, setWaiting] = useState(false);
  const token = useRef(0);
  const waitingRef = useRef(false);

  const set = useCallback((v: boolean) => {
    waitingRef.current = v;
    setWaiting(v);
  }, []);

  const cancel = useCallback(() => {
    token.current++;
    WebAuthnAbortService.cancelCeremony();
    waitingRef.current = false;
    setWaiting(false);
  }, []);

  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false; canceled: true }> => {
      const mine = ++token.current;
      set(true);
      try {
        const value = await fn();
        if (token.current !== mine) return { ok: false, canceled: true };
        set(false);
        return { ok: true, value };
      } catch (err) {
        if (token.current !== mine) return { ok: false, canceled: true };
        set(false);
        if (isCanceledCeremony(err)) return { ok: false, canceled: true };
        throw err;
      }
    },
    [set],
  );

  useEffect(
    () => () => {
      if (waitingRef.current) {
        token.current++;
        WebAuthnAbortService.cancelCeremony();
      }
    },
    [],
  );

  return { waiting, run, cancel };
}
