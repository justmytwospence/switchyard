import { Ellipsis, GripVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/cn";
import { haptic } from "../lib/haptics";
import { usePrefs } from "../prefs";
import {
  DEFAULT_NAV_BAR,
  DEFAULT_NAV_ORDER,
  DESTINATIONS,
  MAX_NAV_BAR,
  type NavId,
  normalizeNav,
} from "./navigation";

/** The list as edited: the bottom-bar destinations, the More divider, then the rest. */
type Entry = NavId | "more";

export function toEntries(order: NavId[], bar: number): Entry[] {
  return [...order.slice(0, bar), "more", ...order.slice(bar)];
}

/**
 * Move one entry, then keep the bar between 1 and MAX_NAV_BAR destinations: a destination
 * dropped into a full bar pushes the bar's last one under More, as on iOS.
 */
export function moveEntry(entries: Entry[], from: number, to: number): Entry[] {
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return entries;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  let d = next.indexOf("more");
  while (d > MAX_NAV_BAR) {
    [next[d - 1], next[d]] = [next[d]!, next[d - 1]!];
    d--;
  }
  while (d < 1) {
    [next[d], next[d + 1]] = [next[d + 1]!, next[d]!];
    d++;
  }
  return next;
}

export function fromEntries(entries: Entry[]): { order: NavId[]; bar: number } {
  return {
    order: entries.filter((e): e is NavId => e !== "more"),
    bar: entries.indexOf("more"),
  };
}

interface Drag {
  from: number;
  pointerId: number;
  startY: number;
  dy: number;
  target: number;
  /** Entry midpoints and heights at the start, relative to the list. */
  mids: number[];
  heights: number[];
}

/**
 * Choose which destinations the phone's bottom bar shows and the order of all of them (the
 * desktop rail uses the same order). Drag by the handle, or focus it and use the arrow keys.
 */
export function NavigationEditor() {
  const navOrder = usePrefs((s) => s.navOrder);
  const navBar = usePrefs((s) => s.navBar);
  const stored = normalizeNav(navOrder, navBar);
  const setPref = usePrefs((s) => s.set);
  const entries = toEntries(stored.order, stored.bar);
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announce, setAnnounce] = useState("");
  const helpId = useId();

  const save = (next: Entry[], moved: NavId) => {
    const { order, bar } = fromEntries(next);
    setPref("navOrder", order);
    setPref("navBar", bar);
    const i = order.indexOf(moved);
    setAnnounce(
      i < bar
        ? `${DESTINATIONS[moved].label}: bottom bar, position ${i + 1} of ${bar}`
        : `${DESTINATIONS[moved].label}: More, position ${i - bar + 1} of ${order.length - bar}`,
    );
  };

  const onPointerDown = (e: React.PointerEvent, from: number) => {
    const list = listRef.current;
    if (!list || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const top = list.getBoundingClientRect().top;
    const rows = [...list.children] as HTMLElement[];
    haptic();
    setDrag({
      from,
      pointerId: e.pointerId,
      startY: e.clientY,
      dy: 0,
      target: from,
      mids: rows.map((r) => r.getBoundingClientRect().top - top + r.offsetHeight / 2),
      heights: rows.map((r) => r.offsetHeight),
    });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;
    const center = drag.mids[drag.from]! + dy;
    let target = 0;
    drag.mids.forEach((m, i) => {
      if (i !== drag.from && center > m) target++;
    });
    if (target !== drag.target) haptic();
    setDrag({ ...drag, dy, target });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const moved = entries[drag.from];
    setDrag(null);
    if (moved && moved !== "more" && drag.target !== drag.from) {
      save(moveEntry(entries, drag.from, drag.target), moved);
    }
  };

  /** Where each entry sits while one is dragged: the others make room. */
  const shift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    const h = drag.heights[drag.from] ?? 0;
    if (drag.from < drag.target && i > drag.from && i <= drag.target) return -h;
    if (drag.target < drag.from && i >= drag.target && i < drag.from) return h;
    return 0;
  };

  return (
    <div className="flex flex-col gap-3">
      <BarPreview order={stored.order} bar={stored.bar} />
      <ol
        ref={listRef}
        aria-label="Navigation order"
        className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
      >
        {entries.map((entry, i) => {
          const dragging = drag?.from === i;
          const style = {
            transform: `translateY(${dragging ? drag.dy : shift(i)}px)`,
            transition:
              dragging || !drag ? "none" : "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          };
          if (entry === "more") {
            return (
              <li
                key="more"
                style={style}
                className="flex items-center gap-2 border-y border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted"
              >
                <Ellipsis aria-hidden className="size-4" />
                Under More
              </li>
            );
          }
          const d = DESTINATIONS[entry];
          const Icon = d.icon;
          const inBar = i < entries.indexOf("more");
          return (
            <li
              key={entry}
              style={style}
              className={cn(
                "relative flex min-h-12 items-center gap-3 bg-surface px-3",
                dragging && "z-10 rounded-md shadow-pop",
              )}
            >
              <Icon
                aria-hidden
                className={cn("size-5 shrink-0", inBar ? "text-accent" : "text-muted")}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.label}</span>
              <button
                type="button"
                aria-label={`Move ${d.label}`}
                aria-describedby={helpId}
                data-no-sheet-drag
                className="tap -mr-1 inline-flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-text active:cursor-grabbing"
                onPointerDown={(e) => onPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : null;
                  if (to === null) return;
                  e.preventDefault();
                  if (to < 0 || to >= entries.length) return;
                  const next = moveEntry(entries, i, to);
                  save(next, entry);
                  // Keep the focus on the moved handle.
                  requestAnimationFrame(() =>
                    listRef.current
                      ?.querySelector<HTMLElement>(`[aria-label="Move ${d.label}"]`)
                      ?.focus(),
                  );
                }}
              >
                <GripVertical aria-hidden className="size-5" />
              </button>
            </li>
          );
        })}
      </ol>
      <p id={helpId} className="text-xs text-muted">
        Drag a page by its handle, or focus the handle and use the arrow keys. Up to {MAX_NAV_BAR}{" "}
        fit in the phone's bottom bar; the rest are under More. Larger screens list them all in this
        order.
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            stored.bar === DEFAULT_NAV_BAR &&
            stored.order.every((id, i) => id === DEFAULT_NAV_ORDER[i])
          }
          onClick={() => {
            setPref("navOrder", DEFAULT_NAV_ORDER);
            setPref("navBar", DEFAULT_NAV_BAR);
            setAnnounce("Navigation reset");
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/** What the phone's bottom bar will look like. */
function BarPreview({ order, bar }: { order: NavId[]; bar: number }) {
  const items = order.slice(0, bar).map((id) => DESTINATIONS[id]);
  return (
    <div
      aria-hidden
      className="grid rounded-lg border border-border bg-surface-2 py-1.5"
      style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
    >
      {[...items, { id: "more", label: "More", icon: Ellipsis }].map((d) => {
        const Icon = d.icon;
        return (
          <span
            key={d.id}
            className="flex min-w-0 flex-col items-center gap-0.5 text-[11px] text-muted"
          >
            <Icon className="size-4" />
            <span className="max-w-full truncate px-1">{d.label}</span>
          </span>
        );
      })}
    </div>
  );
}
