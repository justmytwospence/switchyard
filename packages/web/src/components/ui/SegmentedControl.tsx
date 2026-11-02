import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name. */
  label: string;
  className?: string;
  block?: boolean;
}

/** Radio-group style switcher (e.g. mobile Chat / Changes / Details). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  block,
}: SegmentedControlProps<T>) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex rounded-lg border border-border bg-surface-2 p-0.5",
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
      {options.map((o) => {
        const selected = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: button-based radio group (WAI-ARIA radio pattern)
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "tap inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap",
              selected
                ? "bg-surface text-text shadow-sm border border-border"
                : "text-muted hover:text-text border border-transparent",
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
