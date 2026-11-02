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
  className?: string;
}

/** Vertical resize handle with clamping, pointer drag and keyboard arrows (role=separator). */
export function Splitter({
  value,
  min,
  max,
  onChange,
  label,
  pane = "before",
  step = 16,
  onReset,
  className,
}: SplitterProps) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const sign = pane === "before" ? 1 : -1;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive separator needs role="separator" with focus
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cn(
        "group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none select-none",
        "focus-visible:outline-none",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(clamp(start.current.value + sign * (e.clientX - start.current.x)));
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
        if (e.key === "ArrowRight") onChange(clamp(value + sign * s));
        else if (e.key === "ArrowLeft") onChange(clamp(value - sign * s));
        else if (e.key === "Home") onChange(min);
        else if (e.key === "End") onChange(max);
        else if (e.key === "Enter" && onReset) onReset();
        else return;
        e.preventDefault();
      }}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent"
      />
    </div>
  );
}
