import { type RefObject, useEffect, useRef } from "react";
import {
  registerKeyboardLayer,
  topKeyboardLayer,
  topTrappingKeyboardLayer,
} from "./keyboardLayers";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.closest('[hidden], [inert], [aria-hidden="true"], :disabled, [aria-disabled="true"]') &&
      getComputedStyle(el).visibility !== "hidden" &&
      el.getClientRects().length > 0,
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
    const unregister = registerKeyboardLayer({
      root: ref,
      onEscape: () => escRef.current?.(),
      trapsFocus: true,
    });
    const layer = topKeyboardLayer();
    const target = initialFocus?.current ?? focusableWithin(root)[0] ?? root;
    // Defer so the element is laid out (portals, transitions).
    // An `autoFocus` field inside keeps its focus unless an explicit initial focus was given.
    const raf = requestAnimationFrame(() => {
      if (!initialFocus?.current && root.contains(document.activeElement)) return;
      target.focus({ preventScroll: true });
    });
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || e.isComposing) return;
      if (topTrappingKeyboardLayer() !== layer) return;
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
    document.addEventListener("keydown", onTab);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onTab);
      const wasTop = topKeyboardLayer() === layer;
      unregister();
      // Do not steal focus if this was an underlying layer. For a nested close, only
      // return to an opener that belongs to the still-open top layer.
      if (!wasTop) return;
      const remaining = topKeyboardLayer();
      const remainingRoot = remaining?.root.current;
      if (remaining) {
        const next =
          previous?.isConnected && remainingRoot?.contains(previous)
            ? previous
            : remainingRoot && (focusableWithin(remainingRoot)[0] ?? remainingRoot);
        next?.focus({ preventScroll: true });
      } else {
        const next = previous?.isConnected
          ? previous
          : (document.querySelector<HTMLElement>("main") ?? document.body);
        next.focus({ preventScroll: true });
      }
    };
  }, [active, ref, initialFocus]);
}

let scrollLocks = 0;
let previousOverflow = "";

/** Lock body scroll while at least one modal surface is open. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (scrollLocks++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
    };
  }, [active]);
}
