import { SwitchyardError } from "@switchyard/protocol";
import type { FastifyRequest } from "fastify";

/**
 * Fixed-window in-process limiter for public auth endpoints, keyed by client IP. `req.ip` honours
 * `X-Forwarded-For` only from `SWITCHYARD_TRUSTED_PROXIES`.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private hits = 0;

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Count a hit for `key`; false once the key is over its limit in the current window. */
  hit(key: string): boolean {
    const now = this.clock();
    if (++this.hits % 1000 === 0) this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.limit;
  }

  /** Throw `rate_limited` when the request's IP is over the limit. */
  check(req: FastifyRequest): void {
    if (!this.hit(req.ip)) {
      throw new SwitchyardError("rate_limited", "Too many attempts; wait a minute and try again");
    }
  }

  /** Number of tracked keys (tests). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
  }
}

export const AUTH_RATE_LIMIT = 20;
export const HOSTS_RATE_LIMIT = 10;
