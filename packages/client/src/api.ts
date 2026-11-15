export interface RequestOptions {
  signal?: AbortSignal;
}

/** An error response from the coordinator REST API (`{error: {code, message, details}}`). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  coordinatorUrl: string;
  /** Device credential (or the local admin token), sent as `Authorization: Bearer`. */
  credential: string | null;
  fetch?: FetchLike;
}

/** Minimal JSON REST client for the coordinator. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly credential: string | null;
  private readonly doFetch: FetchLike;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.coordinatorUrl.replace(/\/+$/, "");
    this.credential = opts.credential;
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: options?.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError"))
        throw err;
      throw new ApiRequestError(
        0,
        "host_unreachable",
        `Cannot reach coordinator ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok)
          throw new ApiRequestError(
            res.status,
            "invalid_response",
            `Invalid JSON for ${method} ${path}`,
          );
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
        ?.error;
      throw new ApiRequestError(
        res.status,
        e?.code ??
          (res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : "internal"),
        e?.message ?? `HTTP ${res.status} for ${method} ${path}`,
        e?.details,
      );
    }
    return json as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  post<T>(path: string, body: unknown = {}, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }
}
