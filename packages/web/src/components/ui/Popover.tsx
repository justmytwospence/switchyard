import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { useFocusTrap } from "./useFocusTrap";

export interface PopoverTriggerProps {
  ref: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string;
}

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Accessible name of the panel. */
  label: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  initialFocus?: RefObject<HTMLElement | null>;
  /** Panel classes (width). */
  className?: string;
  /** Position the panel `fixed` and keep it inside the viewport (phones). */
  fitViewport?: boolean;
  children: ReactNode;
}

/** Non-modal panel anchored to its trigger: holds a search box or a slider. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  side = "bottom",
  align = "start",
  initialFocus,
  className,
  fitViewport,
  children,
}: PopoverProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(panelRef, open, () => onOpenChange(false), initialFocus);

  const [fixed, setFixed] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !fitViewport) {
      setFixed(null);
      return;
    }
    const place = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(288, window.innerWidth - 16);
      const left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
      setFixed(
        side === "top"
          ? { position: "fixed", width, left, bottom: window.innerHeight - rect.top + 4 }
          : { position: "fixed", width, left, top: rect.bottom + 4 },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, fitViewport, side]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open, onOpenChange]);

  return (
    <div className="relative inline-flex">
      {trigger({
        ref: btnRef,
        onClick: () => onOpenChange(!open),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": id,
      })}
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          style={fixed ?? undefined}
          className={cn(
            fixed ? "fixed" : "absolute",
            "z-40 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-surface p-3 shadow-pop",
            !fixed && (side === "top" ? "bottom-full mb-1" : "top-full mt-1"),
            !fixed && (align === "end" ? "right-0" : "left-0"),
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
