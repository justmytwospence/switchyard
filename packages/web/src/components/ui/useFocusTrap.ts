import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

/**
 * Modal focus management: moves focus into `ref` when `active`, keeps Tab
 * inside it, closes on Escape, and returns focus to the element that had it
 * (the trigger) when deactivated.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
): void {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  // Remember the trigger while rendering the opening frame: by the time effects run, an
  // `autoFocus` field inside the surface has already taken focus.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== "undefined") {
    triggerRef.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const captured = triggerRef.current;
    const previous =
      captured && !root.contains(captured)
        ? captured
        : (document.activeElement as HTMLElement | null);
    const target = initialFocus?.current ?? focusableWithin(root)[0] ?? root;
    // Defer so the element is laid out (portals, transitions).
    // An `autoFocus` field inside keeps its focus unless an explicit initial focus was given.
    const raf = requestAnimationFrame(() => {
      if (!initialFocus?.current && root.contains(document.activeElement)) return;
      target.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escRef.current) {
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || !root.contains(activeEl))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref, initialFocus]);
}

/** Lock body scroll while a modal surface is open. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}
