import type { ProviderUsage, UsageWindow } from "@switchyard/protocol";
import type { Logger } from "./logger.js";

export interface UsageDeps {
  /** Pi's auth.json. */
  authPath: string;
  fetch: typeof fetch;
  now: () => number;
  readFile: (path: string) => Promise<string>;
}

type Provider = ProviderUsage["provider"];

interface Credential {
  type?: string;
  access?: string;
  expires?: number;
  accountId?: string;
}

const RETRY_MIN_MS = 300_000;
const RETRY_MAX_MS = 3_600_000;
const TIMEOUT_MS = 15_000;

/** Provider -> time before which it must not be fetched again (after a 429). */
export type Backoff = Map<Provider, number>;

function result(
  deps: UsageDeps,
  provider: Provider,
  status: ProviderUsage["status"],
  message: string | null,
  windows: UsageWindow[] = [],
): ProviderUsage {
  return { provider, status, message, windows, fetchedAt: new Date(deps.now()).toISOString() };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function anthropicWindows(body: unknown): UsageWindow[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: UsageWindow[] = [];
  for (const [key, id] of [
    ["five_hour", "five_hour"],
    ["seven_day", "weekly"],
  ] as const) {
    const w = b[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    const used = num(w?.utilization);
    if (used === null) continue;
    out.push({
      id,
      usedPct: used,
      resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
    });
  }
  return out;
}

function codexWindows(body: unknown): UsageWindow[] {
  const rl = ((body ?? {}) as { rate_limit?: Record<string, unknown> | null }).rate_limit;
  const out: UsageWindow[] = [];
  for (const slot of ["primary_window", "secondary_window"]) {
    const w = rl?.[slot] as
      | { used_percent?: unknown; reset_at?: unknown; limit_window_seconds?: unknown }
      | null
      | undefined;
    const used = num(w?.used_percent);
    const secs = num(w?.limit_window_seconds);
    if (used === null) continue;
    const id = secs === 18000 ? "five_hour" : secs === 604800 ? "weekly" : null;
    if (!id) continue;
    const reset = num(w?.reset_at);
    out.push({
      id,
      usedPct: used,
      resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    });
  }
  return out;
}

async function fetchProvider(
  deps: UsageDeps,
  provider: Provider,
  cred: Credential,
  backoff: Backoff,
): Promise<ProviderUsage> {
  if (cred.expires !== undefined && cred.expires <= deps.now()) {
    return result(deps, provider, "expired", "Sign in again in Pi");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.access}`,
    Accept: "application/json",
  };
  let url: string;
  if (provider === "anthropic") {
    url = "https://api.anthropic.com/api/oauth/usage";
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    url = "https://chatgpt.com/backend-api/wham/usage";
    if (cred.accountId) headers["ChatGPT-Account-Id"] = cred.accountId;
  }
  try {
    const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) {
      return result(deps, provider, "rejected", "Pi's sign-in was rejected");
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      const wait = Math.min(
        RETRY_MAX_MS,
        Math.max(RETRY_MIN_MS, Number.isFinite(retry) ? retry * 1000 : 0),
      );
      backoff.set(provider, deps.now() + wait);
      return result(deps, provider, "error", "HTTP 429");
    }
    if (!res.ok) return result(deps, provider, "error", `HTTP ${res.status}`);
    const body: unknown = JSON.parse(await res.text());
    const windows = provider === "anthropic" ? anthropicWindows(body) : codexWindows(body);
    return result(deps, provider, "available", null, windows);
  } catch (err) {
    return result(deps, provider, "error", (err as Error).message);
  }
}

/** Subscription limits for each provider Pi is signed in to with OAuth. Never refreshes tokens. */
export async function readUsage(
  deps: UsageDeps,
  last: Map<Provider, ProviderUsage> = new Map(),
  backoff: Backoff = new Map(),
): Promise<ProviderUsage[]> {
  let auth: Record<string, Credential>;
  try {
    auth = JSON.parse(await deps.readFile(deps.authPath)) as Record<string, Credential>;
  } catch {
    return [];
  }
  const out: ProviderUsage[] = [];
  for (const provider of ["anthropic", "openai-codex"] as const) {
    const cred = auth?.[provider];
    if (!cred || cred.type !== "oauth" || !cred.access) continue;
    const until = backoff.get(provider);
    const prev = last.get(provider);
    if (until !== undefined && deps.now() < until && prev) {
      out.push(prev);
      continue;
    }
    const r = await fetchProvider(deps, provider, cred, backoff);
    last.set(provider, r);
    out.push(r);
  }
  return out;
}

/** Polls usage every few minutes and hands each result to `send`. */
export class UsagePoller {
  private timer: NodeJS.Timeout | null = null;
  private current: ProviderUsage[] | null = null;
  private readonly last = new Map<Provider, ProviderUsage>();
  private readonly backoff: Backoff = new Map();
  private running = false;

  constructor(
    private readonly opts: {
      deps: UsageDeps;
      intervalMs?: number;
      send: (usage: ProviderUsage[]) => void;
      log: Logger;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 300_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): ProviderUsage[] | null {
    return this.current;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.current = await readUsage(this.opts.deps, this.last, this.backoff);
      this.opts.send(this.current);
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message }, "usage refresh failed");
    } finally {
      this.running = false;
    }
  }
}
