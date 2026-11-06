import type { Session } from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";

/** Prompt-cache lifetime in seconds for a session, or null when unknown. */
export function cacheTtlSec(s: Session): number | null {
  if (s.cacheAlert?.ttlSec) return s.cacheAlert.ttlSec;
  const pc = s.promptCache;
  if (!pc) return null;
  const long = pc.cacheWrite1h > 0;
  const meta = s.model?.promptCache;
  if (s.model && s.model.provider === pc.provider && s.model.id === pc.model && meta) {
    const v = long ? meta.long : meta.short;
    if (typeof v === "number") return v;
  }
  if (pc.provider === "anthropic") return long ? 3600 : 300;
  return null;
}

/** When the cache expires and when to warn, or null when there is nothing to warn about. */
export function cacheWarning(
  s: Session,
  _now: number,
): { expiresAt: number; warnAt: number } | null {
  const pc = s.promptCache;
  if (!s.cacheAlert || !pc || s.archivedAt) return null;
  if (s.runtime !== "idle") return null;
  if (pc.cacheRead + pc.cacheWrite <= 0) return null;
  const ttl = cacheTtlSec(s);
  if (!ttl) return null;
  const expiresAt = Date.parse(pc.at) + ttl * 1000;
  const warnAt = expiresAt - Math.min(300, ttl / 2) * 1000;
  return { expiresAt, warnAt };
}

/** Raises "cache expiring" for opted-in idle sessions shortly before their prompt cache lapses. */
export class CacheAlertService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: { tickMs: number },
  ) {}

  start(): void {
    if (this.opts.tickMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = Date.now()): void {
    const { store, attention } = this.ctx;
    for (const s of store.sessions.list("archived_at IS NULL", [])) {
      if (!s.cacheAlert) continue;
      const w = cacheWarning(s, now);
      const pc = s.promptCache;
      if (w && pc && now >= w.warnAt && now < w.expiresAt && s.cacheAlert.warnedFor !== pc.at) {
        store.tx(() => {
          attention.raise({
            reason: "cache_expiring",
            sessionId: s.id,
            projectId: s.projectId,
            summary: `Prompt cache expires in ${Math.max(1, Math.ceil((w.expiresAt - now) / 60000))} min. Send a message to keep it warm.`,
          });
          store.putSession({ ...s, cacheAlert: { ...s.cacheAlert!, warnedFor: pc.at } });
        });
        continue;
      }
      if (!w || now >= w.expiresAt || s.cacheAlert.warnedFor !== pc?.at) {
        attention.resolve({ sessionId: s.id, reason: "cache_expiring" });
      }
    }
  }
}
