import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  info: "bg-info-soft text-info border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  accent: "bg-accent text-accent-fg border-transparent",
};

/** Text colour for each tone (the Badge classes colour the background too). */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
};

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** Accessible text when the visible content is terse (e.g. a count). */
  label?: string;
  className?: string;
}

/** Small pill for counts and tags. */
export function Badge({ children, tone = "neutral", label, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full border px-1.5 text-xs leading-5 font-medium tabular-nums",
        TONE_CLASSES[tone],
        className,
      )}
      title={label}
    >
      <span aria-hidden={label ? true : undefined}>{children}</span>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** Count badge; renders nothing at zero. Caps at 99+. */
export function CountBadge({
  count,
  label,
  tone = "danger",
  className,
}: {
  count: number;
  label: string;
  tone?: Tone;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <Badge tone={tone} label={`${count} ${label}`} className={className}>
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
