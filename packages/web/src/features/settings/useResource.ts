import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../sync/api";

/** Thrown when a response does not have the expected shape (render FatalError). */
export class UnexpectedResponseError extends Error {
  constructor(path: string) {
    super(`Unexpected response from ${path}. The coordinator and this app may be out of sync.`);
    this.name = "UnexpectedResponseError";
  }
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** True while a request is in flight (initial fetch or reload). */
  loading: boolean;
  /** True when the response had an unexpected shape (irrecoverable). */
  fatal: boolean;
  reload: () => void;
  /** Replace the data locally (e.g. with a mutation response). */
  setData: (data: T) => void;
}

interface State<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  fatal: boolean;
}

/**
 * Small GET hook for Settings views. Keeps the previous data while reloading
 * so a refresh never blanks the view. `check` validates the response shape.
 */
export function useResource<T>(
  path: string | null,
  check?: (data: unknown) => boolean,
): Resource<T> {
  const [state, setState] = useState<State<T>>({
    data: undefined,
    error: null,
    loading: path !== null,
    fatal: false,
  });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `check` is a static validator; `nonce` triggers reloads
  useEffect(() => {
    if (!path) return;
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null, fatal: false }));
    apiGet<T>(path, undefined, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return;
        if (check && !check(data)) {
          setState((s) => ({
            ...s,
            loading: false,
            error: new UnexpectedResponseError(path),
            fatal: true,
          }));
          return;
        }
        setState({ data, error: null, loading: false, fatal: false });
      })
      .catch((error: unknown) => {
        if (ac.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error, fatal: false }));
      });
    return () => ac.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (data: T) => setState({ data, error: null, loading: false, fatal: false }),
    [],
  );
  return { ...state, reload, setData };
}

/** True for a plain JSON object. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
