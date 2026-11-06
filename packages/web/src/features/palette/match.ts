import type { PaletteItem } from "./registry";

/** 100 equal, 80 prefix, 60 every token starts a word, 40 substring, 20 subsequence, 0 none. */
export function scoreMatch(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.trim().toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.every((tok) => words.some((w) => w.startsWith(tok)))) return 60;
  if (t.includes(q)) return 40;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

export function rankItems(items: PaletteItem[], query: string, recent: string[]): PaletteItem[] {
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(
        scoreMatch(query, item.title),
        ...(item.keywords ?? []).map((k) => scoreMatch(query, k)),
      ),
    }))
    .filter((x) => x.score > 0);
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.item.activityAt ?? "").localeCompare(a.item.activityAt ?? "") ||
      rank(a.item.id) - rank(b.item.id) ||
      a.item.title.localeCompare(b.item.title),
  );
  return scored.map((x) => x.item);
}

export function emptyQueryItems(
  items: PaletteItem[],
  ctx: { needsYou: Set<string>; review: Set<string> },
): { label: string; items: PaletteItem[] }[] {
  const sessions = items.filter((i) => i.group === "Sessions");
  const byActivity = (a: PaletteItem, b: PaletteItem) =>
    (b.activityAt ?? "").localeCompare(a.activityAt ?? "");
  const needs = sessions.filter((i) => ctx.needsYou.has(i.id)).sort(byActivity);
  const review = sessions
    .filter((i) => !ctx.needsYou.has(i.id) && ctx.review.has(i.id))
    .sort(byActivity);
  const recent = sessions
    .filter((i) => !ctx.needsYou.has(i.id) && !ctx.review.has(i.id))
    .sort(byActivity)
    .slice(0, 10);
  return [
    { label: "Needs you", items: needs },
    { label: "Ready to review", items: review },
    { label: "Recent", items: recent },
    { label: "Actions", items: items.filter((i) => i.group === "Actions") },
  ].filter((s) => s.items.length > 0);
}
