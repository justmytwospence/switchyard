import type { Priority } from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";
import { ArrowDown, ArrowUp, ChevronsUp, Minus } from "lucide-react";
import { cn } from "../../lib/cn";
import { TONE_TEXT } from "./Badge";
import { Select, type SelectProps } from "./Select";
import type { StatusInfo } from "./StatusChip";

export const PRIORITY_INFO: Record<Priority, StatusInfo> = {
  0: { label: PRIORITY_LABELS[0], icon: ChevronsUp, tone: "danger" },
  1: { label: PRIORITY_LABELS[1], icon: ArrowUp, tone: "warning" },
  2: { label: PRIORITY_LABELS[2], icon: Minus, tone: "neutral" },
  3: { label: PRIORITY_LABELS[3], icon: ArrowDown, tone: "neutral" },
};

/** The priority's icon. `className` replaces the default size (size-4). */
export function PriorityIcon({
  priority,
  className,
  colored = true,
}: {
  priority: Priority;
  className?: string;
  /** Tint with the priority's tone (default true). */
  colored?: boolean;
}) {
  const info = PRIORITY_INFO[priority] ?? PRIORITY_INFO[2];
  const Icon = info.icon;
  return (
    <Icon
      aria-hidden
      className={cn("shrink-0", colored && TONE_TEXT[info.tone], className ?? "size-4")}
    />
  );
}

/** Icon plus label. The text takes the tone unless `muted`; the icon always does. */
export function PriorityLabel({
  priority,
  className,
  suffix,
  muted,
}: {
  priority: Priority;
  className?: string;
  /** Appended to the label, e.g. " priority". */
  suffix?: string;
  muted?: boolean;
}) {
  const info = PRIORITY_INFO[priority] ?? PRIORITY_INFO[2];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        muted ? "text-muted" : TONE_TEXT[info.tone],
        className,
      )}
    >
      <PriorityIcon priority={priority} className="size-3.5" />
      {info.label}
      {suffix}
    </span>
  );
}

/** Select of the four priorities. Give it a label with Field or a <label>. */
export function PrioritySelect({
  value,
  onChange,
  ...rest
}: Omit<SelectProps, "value" | "onChange" | "children"> & {
  value: Priority;
  onChange(p: Priority): void;
}) {
  return (
    <Select {...rest} value={value} onChange={(e) => onChange(Number(e.target.value) as Priority)}>
      {PRIORITY_LABELS.map((label, i) => (
        <option key={label} value={i}>
          {label}
        </option>
      ))}
    </Select>
  );
}
