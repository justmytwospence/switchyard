export function shortActivity(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.floor((now.getTime() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 8 * 1440) return `${Math.floor(minutes / 1440)}d`;
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
