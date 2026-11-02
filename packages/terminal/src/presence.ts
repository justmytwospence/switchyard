import type { Presence } from "@switchyard/protocol";

/**
 * Terminal presence is based on interaction: Ink cannot tell whether the terminal window is
 * focused, so the client counts as foreground for 45 s after each keypress. Socket connection
 * alone is never presence.
 */
export const FOREGROUND_MS = 45_000;
/** Presence is re-sent at this interval and on every change. */
export const PRESENCE_INTERVAL_MS = 20_000;
/** Keypresses re-send presence (with a fresh `interactedAt`) at most this often. */
export const KEYPRESS_THROTTLE_MS = 5_000;

export function computePresence(
  now: number,
  lastKeyAt: number | null,
  viewingSessionId: string | null,
): Presence {
  return {
    foreground: lastKeyAt !== null && now - lastKeyAt < FOREGROUND_MS,
    interactedAt: lastKeyAt === null ? null : new Date(lastKeyAt).toISOString(),
    viewing: viewingSessionId ? { sessionId: viewingSessionId } : null,
  };
}

/** Whether a presence change is significant enough to send immediately. */
export function presenceChanged(prev: Presence | null, next: Presence): boolean {
  if (!prev) return true;
  return (
    prev.foreground !== next.foreground ||
    (prev.viewing?.sessionId ?? null) !== (next.viewing?.sessionId ?? null)
  );
}

/** Should a keypress at `now` send presence, given the last send time? */
export function keypressShouldSend(
  prev: Presence | null,
  next: Presence,
  now: number,
  lastSentAt: number | null,
): boolean {
  if (presenceChanged(prev, next)) return true;
  return lastSentAt === null || now - lastSentAt >= KEYPRESS_THROTTLE_MS;
}

/** Reconnect delay for attempt `n` (1-based): 1, 2, 5, 10, 20, 30 s with +-20% jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
  const base = steps[Math.min(Math.max(attempt, 1), steps.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}
