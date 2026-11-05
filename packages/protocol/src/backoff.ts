/** Reconnect delays for hosts and clients; the last value repeats. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 20000, 30000];

/** Delay before reconnect attempt `attempt` (0-based), with +-20% jitter. */
export function reconnectDelay(
  attempt: number,
  steps: readonly number[] = RECONNECT_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const base = steps[Math.min(Math.max(attempt, 0), steps.length - 1)] ?? 30_000;
  return Math.max(0, Math.round(base * (0.8 + random() * 0.4)));
}
