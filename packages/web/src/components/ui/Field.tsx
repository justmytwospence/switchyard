import { TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

/** Props to spread on the control inside a Field. */
export interface FieldControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Appends " (optional)" in muted text. */
  optional?: boolean;
  /** Control id; defaults to a generated one. */
  id?: string;
  className?: string;
  /** The control, or a render function that receives the props to spread on it. */
  children: ReactNode | ((p: FieldControlProps) => ReactElement);
}

/** aria-describedby / aria-invalid props for the control of a Field with this id. */
export function fieldControlProps(
  id: string,
  opts: { hint?: boolean; error?: string | null },
): Omit<FieldControlProps, "id"> {
  const ids = [opts.hint && `${id}-hint`, opts.error && `${id}-error`].filter(Boolean);
  return {
    "aria-describedby": ids.length ? ids.join(" ") : undefined,
    "aria-invalid": opts.error ? true : undefined,
  };
}

/** Inline field error with an icon (the icon keeps it from relying on colour). */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1 text-xs text-danger" data-field-error>
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-line break-words">{children}</span>
    </p>
  );
}

/** Label, control, hint and error. Controls must use the `id` and described-by props. */
export function Field({ label, hint, error, optional, id, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <div className={cn("flex w-full min-w-0 max-w-2xl flex-col gap-1", className)}>
      <label htmlFor={controlId} className="text-sm font-medium">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {typeof children === "function"
        ? children({ id: controlId, ...fieldControlProps(controlId, { hint: !!hint, error }) })
        : children}
      {hint && (
        <p id={`${controlId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${controlId}-error`}>{error}</FieldError>}
    </div>
  );
}
