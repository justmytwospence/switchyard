import { type ReactNode, useEffect, useId, useRef } from "react";
import { horizontalNavigationDelta } from "../../features/palette/shortcuts";
import { cn } from "../../lib/cn";
import type { SwipeProgress } from "../../lib/swipeProgress";
import { usePrefs } from "../../prefs";
import { useIndicator } from "./useIndicator";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Trailing content, e.g. a CountBadge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
  /** Prefix for tab/panel ids so TabPanel can reference them. */
  idPrefix?: string;
  /** Allow the list to scroll horizontally (mobile status tabs). */
  scrollable?: boolean;
  /** A swipe between the tabs' panels; the underline follows it. */
  progress?: SwipeProgress;
}

export function tabId(prefix: string, id: string) {
  return `${prefix}-tab-${id}`;
}
export function panelId(prefix: string, id: string) {
  return `${prefix}-panel-${id}`;
}

/** WAI-ARIA tabs (automatic activation with arrow keys, Home, End). */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
  className,
  idPrefix,
  scrollable,
  progress,
}: TabsProps) {
  const autoId = useId();
  const prefix = idPrefix ?? autoId;
  const listRef = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(listRef, value, progress);
  const enabled = tabs.filter((t) => !t.disabled);
  // A swipe elsewhere can change the tab: keep the selected one in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the selection matters
  useEffect(() => {
    if (!scrollable) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    listRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
  }, [value, scrollable]);
  const move = (dir: number | "first" | "last") => {
    const idx = enabled.findIndex((t) => t.id === value);
    const next =
      dir === "first"
        ? enabled[0]
        : dir === "last"
          ? enabled[enabled.length - 1]
          : enabled[(idx + dir + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.id);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(prefix, next.id))}`)
        ?.focus(),
    );
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-indicator-root
      className={cn(
        // Positioned, so a tab's absolutely placed parts (its badge's sr-only text) stay inside
        // the list instead of widening the page behind it.
        "relative flex gap-1 border-b border-border",
        // Sideways only: a tab reaching past the list (below) would make it wobble up and down.
        scrollable &&
          "overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]",
        className,
      )}
      onKeyDown={(e) => {
        const vim =
          usePrefs.getState().vimNavigation &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.nativeEvent.isComposing;
        const delta = horizontalNavigationDelta(e.key, vim);
        if (delta) move(delta);
        else if (e.key === "Home") move("first");
        else if (e.key === "End") move("last");
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            id={tabId(prefix, t.id)}
            data-indicator-key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(prefix, t.id)}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={cn(
              "tap inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              // The selected underline covers the list's border, except where the list scrolls.
              !scrollable && "-mb-px",
              "border-transparent transition-colors",
              selected ? "text-text" : "text-muted hover:text-text",
              "disabled:opacity-55",
            )}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
      {/* The selected tab's underline: one bar that slides between tabs. */}
      <span
        ref={indicator}
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 h-0.5 rounded-full bg-accent opacity-0",
          scrollable ? "bottom-0" : "-bottom-px",
        )}
      />
    </div>
  );
}

export function TabPanel({
  idPrefix,
  id,
  children,
  className,
  hidden,
}: {
  idPrefix: string;
  id: string;
  children: ReactNode;
  className?: string;
  hidden?: boolean;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      hidden={hidden}
      className={className}
    >
      {children}
    </div>
  );
}
