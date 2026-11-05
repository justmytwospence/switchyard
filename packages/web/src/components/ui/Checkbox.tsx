import { type InputHTMLAttributes, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export interface CheckboxProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "checked" | "onChange" | "className"
  > {
  label: ReactNode;
  /** Shown under the label; kept outside the label so it is not part of the accessible name. */
  description?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  /** Classes for the clickable label row. */
  className?: string;
}

/** Native checkbox with its label; the whole row is the touch target. */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const generated = useId();
  const descId = description ? `${id ?? generated}-desc` : undefined;
  return (
    <div className="flex min-w-0 flex-col">
      <label
        className={cn(
          "tap inline-flex min-w-0 cursor-pointer items-center gap-2 text-sm",
          className,
        )}
      >
        <input
          {...rest}
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={descId ?? rest["aria-describedby"]}
          className="size-4 shrink-0 accent-[var(--sy-accent)]"
        />
        <span className={cn("min-w-0", !!description && "font-medium")}>{label}</span>
      </label>
      {description && (
        <p id={descId} className="pl-6 text-sm text-muted">
          {description}
        </p>
      )}
    </div>
  );
}
