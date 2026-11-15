import type { NavigationAction } from "./shortcuts";

const SCOPE = "[data-keyboard-scope]";
const ITEM = "[data-keyboard-item]";

export function nextIndex(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + direction));
}

export function adjacentColumnTarget(
  counts: readonly number[],
  column: number,
  row: number,
  direction: -1 | 1,
): { column: number; row: number } | null {
  for (let i = column + direction; i >= 0 && i < counts.length; i += direction) {
    if ((counts[i] ?? 0) > 0) return { column: i, row: Math.min(row, counts[i]! - 1) };
  }
  return null;
}

export function visible(el: HTMLElement): boolean {
  if (!el.isConnected || !el.getClientRects().length) return false;
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (el.matches(":disabled, [aria-disabled='true']")) return false;
  return true;
}

export function itemsIn(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(ITEM)].filter(
    (item) => item.closest(SCOPE) === scope && visible(item),
  );
}

function focus(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function scopeOf(target: HTMLElement | null): HTMLElement | null {
  return target?.closest<HTMLElement>(SCOPE) ?? null;
}

function defaultScope(): HTMLElement | null {
  const root = [...document.querySelectorAll<HTMLElement>("[data-keyboard-default]")].find(visible);
  if (!root) return null;
  if (root.matches("[data-keyboard-columns]")) {
    return (
      [...root.querySelectorAll<HTMLElement>("[data-keyboard-column]")].find(
        (column) => visible(column) && itemsIn(column).length > 0,
      ) ?? null
    );
  }
  return root;
}

function scrollTranscript(el: HTMLElement, action: NavigationAction): boolean {
  if (!el.matches('[data-keyboard-scroll="transcript"]')) return false;
  const delta =
    action === "halfDown"
      ? el.clientHeight / 2
      : action === "halfUp"
        ? -el.clientHeight / 2
        : action === "next"
          ? 48
          : action === "previous"
            ? -48
            : 0;
  if (action === "first") el.scrollTop = 0;
  else if (action === "last") el.scrollTop = el.scrollHeight;
  else if (delta) el.scrollBy({ top: delta, behavior: "instant" });
  else return false;
  return true;
}

const lastPaneTarget = new WeakMap<HTMLElement, HTMLElement>();

export function handleNavigationAction(
  action: NavigationAction,
  target: HTMLElement | null,
): boolean {
  if (action === "search") {
    const local = target?.closest<HTMLElement>("[data-keyboard-pane], [data-keyboard-scope]");
    const search = [
      ...(local?.querySelectorAll<HTMLElement>("[data-keyboard-search]") ?? []),
      ...document.querySelectorAll<HTMLElement>("main [data-keyboard-search]"),
    ].find(visible);
    if (!search) return false;
    focus(search);
    return true;
  }
  if (action === "composer") {
    const el = [...document.querySelectorAll<HTMLElement>("main [data-keyboard-composer]")].find(
      visible,
    );
    if (!el) return false;
    focus(el);
    return true;
  }
  const transcript = target?.closest<HTMLElement>('[data-keyboard-scroll="transcript"]');
  if (transcript && scrollTranscript(transcript, action)) return true;
  if (action === "halfDown" || action === "halfUp") return false;

  if (action === "left" || action === "right") {
    const column = target?.closest<HTMLElement>("[data-keyboard-column]");
    const columnsRoot = column?.closest<HTMLElement>("[data-keyboard-columns]");
    if (column && columnsRoot) {
      const cols = [...columnsRoot.querySelectorAll<HTMLElement>("[data-keyboard-column]")].filter(
        visible,
      );
      const index = cols.indexOf(column);
      const currentItems = itemsIn(column);
      const current = target?.closest<HTMLElement>(ITEM);
      const row = current ? Math.max(0, currentItems.indexOf(current)) : 0;
      const destination = adjacentColumnTarget(
        cols.map((c) => itemsIn(c).length),
        index,
        row,
        action === "right" ? 1 : -1,
      );
      const el = destination && itemsIn(cols[destination.column]!)[destination.row];
      if (!el) return false;
      focus(el);
      return true;
    }
    const pane = target?.closest<HTMLElement>("[data-keyboard-pane]");
    if (!pane) return false;
    const panes = [...document.querySelectorAll<HTMLElement>("main [data-keyboard-pane]")].filter(
      visible,
    );
    const adjacent = panes[panes.indexOf(pane) + (action === "right" ? 1 : -1)];
    if (!adjacent) return false;
    if (target && pane.contains(target)) lastPaneTarget.set(pane, target);
    const remembered = lastPaneTarget.get(adjacent);
    const el =
      remembered && adjacent.contains(remembered) && visible(remembered)
        ? remembered
        : (adjacent.querySelector<HTMLElement>(
            "[aria-current='page'], [role='tab'][aria-selected='true']",
          ) ??
          itemsIn(adjacent)[0] ??
          adjacent);
    focus(el);
    return true;
  }

  const scope = scopeOf(target) ?? defaultScope();
  if (!scope || !visible(scope)) return false;
  const items = itemsIn(scope);
  if (!items.length) return false;
  const current = target?.closest<HTMLElement>(ITEM) ?? null;
  const index = current ? items.indexOf(current) : -1;
  const next =
    action === "first"
      ? 0
      : action === "last"
        ? items.length - 1
        : action === "next" || action === "previous"
          ? nextIndex(index, items.length, action === "next" ? 1 : -1)
          : -1;
  const el = items[next];
  if (!el) return false;
  focus(el);
  return true;
}
