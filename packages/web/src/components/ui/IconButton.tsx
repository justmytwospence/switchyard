import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Accessible name (also the tooltip). Required: icon-only controls need a label. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "danger";
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "tap inline-flex shrink-0 items-center justify-center rounded-md border transition-colors",
        "disabled:opacity-55 disabled:pointer-events-none",
        size === "sm" ? "size-8" : "size-9",
        variant === "ghost" && "border-transparent text-muted hover:bg-surface-2 hover:text-text",
        variant === "secondary" && "border-border bg-surface text-text hover:bg-surface-2",
        variant === "danger" && "border-transparent text-danger hover:bg-danger-soft",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
