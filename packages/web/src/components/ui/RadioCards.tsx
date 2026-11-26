import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn";

export type RadioCardOption<T extends string> = { value: T; label: string; explanation: string };

/** A group of radio options as bordered cards, each with a label and one sentence. */
export function RadioCards<T extends string>({
  legend,
  value,
  options,
  onChange,
  hint,
  columns = 3,
}: {
  legend: string;
  value: T;
  options: RadioCardOption<T>[];
  onChange: (v: T) => void;
  hint?: ReactNode;
  /** Cards per row from the sm breakpoint up (always one on a phone). */
  columns?: 1 | 3;
}) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className={cn("grid min-w-0 gap-2", columns === 3 && "sm:grid-cols-3")}>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "tap flex min-w-0 cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1",
              value === o.value
                ? "border-accent bg-accent-soft"
                : "border-border hover:bg-surface-2",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              <span className="block text-xs text-muted">{o.explanation}</span>
            </span>
          </label>
        ))}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}
