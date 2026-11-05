import type { ReactNode } from "react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

interface SwitchBase {
  checked: boolean;
  onChange(next: boolean): void;
  busy?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  className?: string;
}

function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-2",
      )}
    >
      <span
        className={cn(
          "absolute size-4 rounded-full shadow-sm transition-transform",
          checked ? "translate-x-5 bg-accent-fg" : "translate-x-1 bg-muted",
        )}
      />
    </span>
  );
}

/** Compact on/off switch: the track plus text that states the current value. */
export function Switch({
  checked,
  onChange,
  label,
  onText = "On",
  offText = "Off",
  busy,
  disabled,
  id,
  className,
  ...aria
}: SwitchBase & {
  /** Accessible name. */
  label: string;
  onText?: string;
  offText?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-invalid={aria["aria-invalid"]}
      aria-describedby={aria["aria-describedby"]}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        "tap inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md px-1.5 text-sm",
        "hover:bg-surface-2 disabled:opacity-60",
        className,
      )}
    >
      <SwitchTrack checked={checked} />
      {busy ? <Spinner className="size-3.5" /> : null}
      <span className={checked ? "text-text" : "text-muted"}>{checked ? onText : offText}</span>
    </button>
  );
}

/** Switch row: the track, a visible label with "(On)/(Off)" and a description; the whole row is clickable. */
export function SwitchRow({
  checked,
  onChange,
  label,
  description,
  busy,
  disabled,
  id,
  className,
  ...aria
}: SwitchBase & { label: ReactNode; description?: ReactNode }) {
  const generated = useId();
  const switchId = id ?? generated;
  const descId = `${switchId}-desc`;
  const describedBy = [description ? descId : null, aria["aria-describedby"]]
    .filter(Boolean)
    .join(" ");
  const off = disabled || busy;
  return (
    <div className={cn("flex min-w-0 items-start gap-3", className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        aria-invalid={aria["aria-invalid"]}
        aria-describedby={describedBy || undefined}
        disabled={off}
        onClick={() => onChange(!checked)}
        className={cn("tap mt-0.5 rounded-full", off && "cursor-not-allowed opacity-60")}
      >
        <SwitchTrack checked={checked} />
      </button>
      <label
        htmlFor={switchId}
        className={cn("min-w-0 flex-1", off ? "cursor-not-allowed opacity-60" : "cursor-pointer")}
      >
        <span className="block text-sm font-medium">
          {label}{" "}
          <span aria-hidden className="font-normal text-muted">
            ({checked ? "On" : "Off"})
          </span>
        </span>
        {description && (
          <span id={descId} className="block text-sm text-muted">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}
