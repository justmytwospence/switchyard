import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../sync/api";

/** Thrown when a response does not have the expected shape (render FatalError). */
export class UnexpectedResponseError extends Error {
  constructor(path: string) {
    super(`Unexpected response from ${path}. The coordinator and this app may be out of sync.`);
    this.name = "UnexpectedResponseError";
  }
}

export interface Resource<T> {
  data: T | undefined;
  /** The last error; kept until the next result arrives. */
  error: unknown;
  /** True while a request is in flight (initial fetch, reload or refresh). */
  loading: boolean;
  /** True when the response had an unexpected shape (irrecoverable). */
  fatal: boolean;
  /** Refetch; keeps the last data while loading. */
  reload: () => void;
  /** Replace the data locally (e.g. with a mutation response). */
  setData: (data: T) => void;
}

export interface ResourceOptions {
  /** Refetch on this interval while the page is visible. */
  refreshMs?: number;
  /** Validates the response shape; a failure makes the resource `fatal`. */
  check?: (data: unknown) => boolean;
}

/**
 * Fetch a resource. `key` changes trigger a refetch; null skips fetching. Errors
 * keep the last good data so views can show last-known state.
 */
export function useResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: ResourceOptions = {},
): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [fatal, setFatal] = useState(false);
  const [loading, setLoading] = useState(key !== null);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const checkRef = useRef(opts.check);
  checkRef.current = opts.check;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a reload
  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetcherRef
      .current(ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        const check = checkRef.current;
        if (check && !check(d)) {
          setError(new UnexpectedResponseError(key));
          setFatal(true);
          return;
        }
        setDataState(d);
        setError(null);
        setFatal(false);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e);
        setFatal(false);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [key, nonce]);

  useEffect(() => {
    if (!opts.refreshMs || key === null) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    }, opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((d: T) => {
    setDataState(d);
    setError(null);
    setFatal(false);
    setLoading(false);
  }, []);
  return { data, error, loading, fatal, reload, setData };
}

/** GET an API path as a resource. `check` validates the response shape. */
export function useApiResource<T>(
  path: string | null,
  check?: (data: unknown) => boolean,
): Resource<T> {
  return useResource<T>(
    path,
    (signal) => apiGet<T>(path as string, undefined, signal),
    check ? { check } : undefined,
  );
}

/** True for a plain JSON object. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
