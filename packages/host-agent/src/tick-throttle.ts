/** A value that only ticks (digits change, nothing else) is sent at most this often. */
export const TICK_WINDOW_MS = 30_000;

/** The value with every run of digits collapsed: equal shapes differ only in numbers. */
export function tickShape(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/\d+/g, "0");
}

interface Entry<T> {
  shape: string;
  sentAt: number;
  latest: { value: T } | null;
  timer: NodeJS.Timeout | null;
}

/**
 * Rate-limits values that tick, such as a status line with a countdown. A change of shape is sent
 * at once. A change of digits only is held and the latest one is sent when the window ends, so a
 * clock that ticks every second costs one durable event per window instead of one per second.
 */
export class TickThrottle<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly send: (key: string, value: T) => void,
    private readonly windowMs = TICK_WINDOW_MS,
  ) {}

  offer(key: string, value: T): void {
    const shape = tickShape(value);
    const now = Date.now();
    const e = this.entries.get(key);
    if (e && e.shape === shape && now - e.sentAt < this.windowMs) {
      e.latest = { value };
      if (!e.timer) {
        e.timer = setTimeout(() => this.flush(key), this.windowMs - (now - e.sentAt));
        e.timer.unref();
      }
      return;
    }
    if (e?.timer) clearTimeout(e.timer);
    this.entries.set(key, { shape, sentAt: now, latest: null, timer: null });
    this.send(key, value);
  }

  /** Drop everything held, unsent. */
  clear(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }

  private flush(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.timer = null;
    const held = e.latest;
    if (!held) return;
    e.latest = null;
    e.sentAt = Date.now();
    this.send(key, held.value);
  }
}
