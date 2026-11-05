import { type ReactNode, useId, useRef } from "react";
import { cn } from "../../lib/cn";

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
}

export function tabId(prefix: string, id: string) {
  return `${prefix}-tab-${id}`;
}
export function panelId(prefix: string, id: string) {
  return `${prefix}-panel-${id}`;
}

/** WAI-ARIA tabs (automatic activation with arrow keys, Home, End). */
export function Tabs({ tabs, value, onChange, label, className, idPrefix, scrollable }: TabsProps) {
  const autoId = useId();
  const prefix = idPrefix ?? autoId;
  const listRef = useRef<HTMLDivElement>(null);
  const enabled = tabs.filter((t) => !t.disabled);
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
      className={cn(
        "flex gap-1 border-b border-border",
        scrollable && "overflow-x-auto overscroll-x-contain [scrollbar-width:none]",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        else if (e.key === "ArrowLeft") move(-1);
        else if (e.key === "Home") move("first");
        else if (e.key === "End") move("last");
        else return;
        e.preventDefault();
      }}
    >
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            id={tabId(prefix, t.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(prefix, t.id)}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={cn(
              "tap -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              selected
                ? "border-accent text-text"
                : "border-transparent text-muted hover:text-text",
              "disabled:opacity-55",
            )}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
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
