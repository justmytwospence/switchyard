import type { NavRow } from "./model";

export function branchChildren(
  row: NavRow,
  selectedId: string | null,
  expanded: boolean,
): { visible: NavRow[]; optionalCount: number } {
  const required = (child: NavRow) => child.attention || child.session.id === selectedId;
  const optionalCount = row.others.filter((child) => !required(child)).length;
  return { visible: expanded ? row.others : row.others.filter(required), optionalCount };
}

export function branchActivity(row: NavRow): string {
  let latest = row.session.lastActivityAt;
  let time = Date.parse(latest);
  for (const child of row.others) {
    const date = child.session.lastActivityAt;
    const ms = Date.parse(date);
    if (Number.isFinite(ms) && (!Number.isFinite(time) || ms > time)) {
      time = ms;
      latest = date;
    }
  }
  return latest;
}

export function recentSections(
  rows: NavRow[],
  needsInputFirst: boolean,
  now: Date,
): { label: string; rows: NavRow[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const sections = ["Needs input", "Today", "Yesterday", "Earlier"].map((label) => ({
    label,
    rows: [] as NavRow[],
  }));
  for (const row of rows) {
    const time = Date.parse(branchActivity(row));
    const index =
      needsInputFirst && (row.attention || row.othersNeedInput)
        ? 0
        : time >= today
          ? 1
          : time >= yesterday
            ? 2
            : 3;
    sections[index]!.rows.push(row);
  }
  return sections.filter((section) => section.rows.length > 0);
}

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
