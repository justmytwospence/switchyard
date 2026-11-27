import { type ReactNode, useRef } from "react";
import { cn } from "../../lib/cn";
import type { SwipeProgress } from "../../lib/swipeProgress";
import { useIndicator } from "./useIndicator";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Tooltip. */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name. */
  label: string;
  className?: string;
  block?: boolean;
  /** A swipe between the options' panels; the selection follows it. */
  progress?: SwipeProgress;
}

/** Radio-group style switcher (e.g. mobile Chat / Changes / Details). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  block,
  progress,
}: SegmentedControlProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useIndicator(root, value, progress);
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={label}
      data-indicator-root
      className={cn(
        "relative inline-flex rounded-lg border border-border bg-surface-2 p-0.5",
        block && "flex w-full",
        className,
      )}
      onKeyDown={(e) => {
        let next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          next = (idx - 1 + options.length) % options.length;
        if (next < 0) return;
        e.preventDefault();
        onChange(options[next]!.value);
        const btns = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
        btns[next]?.focus();
      }}
    >
      {/* The selection: one thumb that slides between the options. */}
      <span
        ref={thumb}
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0 rounded-md border border-border bg-surface opacity-0 shadow-sm"
      />
      {options.map((o) => {
        const selected = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: button-based radio group (WAI-ARIA radio pattern)
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            tabIndex={selected ? 0 : -1}
            data-indicator-key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "tap relative inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors",
              selected ? "text-text" : "text-muted hover:text-text",
            )}
          >
            {o.icon}
            {o.label}
            {o.badge}
          </button>
        );
      })}
    </div>
  );
}
