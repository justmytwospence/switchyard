/** Reconnect delay for the client socket. */

/** Reconnect delay for attempt `n` (1-based): 1, 2, 5, 10, 20, 30 s with +-20% jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
  const base = steps[Math.min(Math.max(attempt, 1), steps.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}
