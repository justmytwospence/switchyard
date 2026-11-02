import type { ErrorCode } from "@switchyard/protocol";

/** Client-side error codes in addition to the protocol's shared codes. */
export type ApiClientErrorCode = ErrorCode | "network" | "http";

/** Every failed REST call rejects with this. `code` is the protocol `ApiError` code. */
export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ApiClientErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: ApiClientErrorCode): e is ApiClientError {
  return e instanceof ApiClientError && (code === undefined || e.code === code);
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

type UnauthorizedListener = (code: ApiClientErrorCode) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Called when any request comes back 401 (the auth gate redirects to /enroll). */
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/**
 * fetch wrapper for the coordinator REST API. Sends cookies, the CSRF header
 * `X-Switchyard-Request: 1`, and JSON bodies; maps `ApiError` bodies to
 * `ApiClientError`.
 */
export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Switchyard-Request": "1",
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: "include",
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiClientError("network", "Could not reach the coordinator", 0);
  }
  const text = await res.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const err = parseErrorBody(json);
    const e = err
      ? new ApiClientError(err.code, err.message, res.status, err.details)
      : new ApiClientError(
          res.status === 401 ? "unauthorized" : "http",
          `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`,
          res.status,
        );
    if (res.status === 401) for (const fn of unauthorizedListeners) fn(e.code);
    throw e;
  }
  return json as T;
}

function parseErrorBody(
  json: unknown,
): { code: ErrorCode; message: string; details?: unknown } | null {
  if (!json || typeof json !== "object") return null;
  const err = (json as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const { code, message, details } = err as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== "string") return null;
  return {
    code: code as ErrorCode,
    message: typeof message === "string" ? message : code,
    details,
  };
}

export const apiGet = <T>(path: string, query?: Query, signal?: AbortSignal) =>
  api<T>(path, { method: "GET", query, signal });
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body ?? {} });
export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const apiPut = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const apiDelete = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "DELETE", body });
