import {
  forwardRef,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../../lib/cn";

/** Shared look of text controls: border, focus ring, invalid and disabled states. */
export const CONTROL_CLASSES = cn(
  "rounded-md border border-border bg-surface text-base text-text placeholder:text-subtle md:text-sm",
  "outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-0 focus-visible:outline-[var(--sy-focus)]",
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:border-danger",
  "disabled:cursor-not-allowed disabled:opacity-55",
);

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Max height before scrolling internally (CSS length; default "33vh"). */
  maxHeight?: string;
  /** Minimum rows (default 1). */
  minRows?: number;
}

/** Auto-growing textarea that scrolls internally past `maxHeight`. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { maxHeight = "33vh", minRows = 1, className, value, style, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the value changes
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [value]);
  return (
    <textarea
      ref={setRef}
      rows={minRows}
      value={value}
      style={{ maxHeight, ...style }}
      className={cn(
        "block w-full resize-none overflow-y-auto px-3 py-2",
        CONTROL_CLASSES,
        className,
      )}
      {...rest}
    />
  );
});

/** Single-line input with the same styling. */
export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn("tap block h-9 w-full px-3", CONTROL_CLASSES, className)}
        {...rest}
      />
    );
  },
);
