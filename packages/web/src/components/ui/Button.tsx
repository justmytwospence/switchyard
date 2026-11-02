import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon shown before the label. */
  icon?: ReactNode;
  /** Shows a spinner and sets aria-busy; the button is disabled while busy. */
  busy?: boolean;
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary: "bg-surface text-text border-border hover:bg-surface-2",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-2",
  danger: "bg-danger text-danger-fg border-danger hover:bg-danger-hover hover:border-danger-hover",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-sm gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cn(
    "tap inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none",
    "transition-colors disabled:opacity-55 disabled:pointer-events-none",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    busy,
    block,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClasses(variant, size, cn(block && "w-full", className))}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={cn("size-4 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
