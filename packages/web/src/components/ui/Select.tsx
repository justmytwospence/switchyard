import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { CONTROL_CLASSES } from "./TextArea";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** "full" (default) fills its container; "auto" sizes to content for inline toolbars. */
  width?: "full" | "auto";
}

/** Native select with the same look, focus ring and invalid state as TextInput. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, width = "full", children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "tap block h-9 min-w-0 px-2.5",
        width === "auto" ? "w-auto" : "w-full",
        CONTROL_CLASSES,
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
