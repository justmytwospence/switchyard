import { useRef } from "react";
import { cn } from "../../lib/cn";

export interface SplitterProps {
  /** Current size in px of the pane being resized. */
  value: number;
  min: number;
  max: number;
  onChange: (px: number) => void;
  /** Accessible name, e.g. "Resize navigator". */
  label: string;
  /**
   * Which side of the splitter the resized pane is on. "before" (default):
   * dragging right grows it (a left pane). "after": dragging left grows it (a right pane).
   */
  pane?: "before" | "after";
  /** Keyboard step in px (Shift multiplies by 4). */
  step?: number;
  /** Called on double-click / Enter to reset. */
  onReset?: () => void;
  /**
   * "vertical" (default): a column divider between side-by-side panes, dragged left and right.
   * "horizontal": a row divider between stacked panes, dragged up and down ("before" is above).
   */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

/** Resize handle with clamping, pointer drag and keyboard arrows (role=separator). */
export function Splitter({
  value,
  min,
  max,
  onChange,
  label,
  pane = "before",
  step = 16,
  onReset,
  orientation = "vertical",
  className,
}: SplitterProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const sign = pane === "before" ? 1 : -1;
  const row = orientation === "horizontal";
  const grow = row ? "ArrowDown" : "ArrowRight";
  const shrink = row ? "ArrowUp" : "ArrowLeft";
  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive separator needs role="separator" with focus
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cn(
        "group relative z-10 shrink-0 touch-none select-none",
        row ? "h-1.5 w-full cursor-row-resize" : "w-1.5 cursor-col-resize",
        "focus-visible:outline-none",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: row ? e.clientY : e.clientX, value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const at = row ? e.clientY : e.clientX;
        onChange(clamp(start.current.value + sign * (at - start.current.x)));
      }}
      onPointerUp={(e) => {
        start.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const s = e.shiftKey ? step * 4 : step;
        if (e.key === grow) onChange(clamp(value + sign * s));
        else if (e.key === shrink) onChange(clamp(value - sign * s));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else if (e.key === "Enter" && onReset) onReset();
        else return;
        e.preventDefault();
      }}
    >
      <div
        aria-hidden
        className={cn(
          "absolute bg-border group-hover:bg-accent group-focus-visible:bg-accent",
          row
            ? "inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover:h-0.5 group-focus-visible:h-0.5"
            : "inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:w-0.5 group-focus-visible:w-0.5",
        )}
      />
    </div>
  );
}
