import { useSyncExternalStore } from "react";

/**
 * True while the on-screen keyboard is up for a text field: the viewport is under 75% of its
 * unobstructed height and focus is in a textarea or text input. The bottom nav hides then
 * (spec 10).
 *
 * iOS ignores `interactive-widget`, so only the visual viewport shrinks and `innerHeight`
 * stays put. Android Chrome honours `resizes-content` (index.html), so `innerHeight` shrinks
 * with the keyboard too and a ratio against it never drops. We therefore compare against the
 * height recorded while no text field was focused (per layout width, so rotation starts a new
 * baseline), falling back to the oriented screen height before one exists.
 */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      el.type,
    );
  }
  return (el as HTMLElement).isContentEditable === true;
}

const KEYBOARD_RATIO = 0.75;
/** Unobstructed viewport height per layout width, recorded while no text field is focused. */
const baselines = new Map<number, number>();

export function keyboardOpen(i: {
  focused: boolean;
  viewportHeight: number;
  baseline: number | null;
  screenHeight: number;
}): boolean {
  if (!i.focused) return false;
  const reference = i.baseline ?? i.screenHeight;
  return reference > 0 && i.viewportHeight < reference * KEYBOARD_RATIO;
}

function orientedScreenHeight(): number {
  const { width, height } = window.screen;
  const landscape = window.matchMedia?.("(orientation: landscape)").matches ?? width > height;
  return landscape ? Math.min(width, height) : Math.max(width, height);
}

function compute(): boolean {
  if (typeof window === "undefined") return false;
  const vv = window.visualViewport;
  if (!vv) return false;
  const focused = isTextField(document.activeElement);
  const width = window.innerWidth; // changes on rotation, not with the keyboard
  // The latest unfocused height (not the maximum), so split-screen resizes leave no stale value.
  if (!focused) baselines.set(width, Math.max(window.innerHeight, vv.height));
  return keyboardOpen({
    focused,
    viewportHeight: Math.min(vv.height, window.innerHeight),
    baseline: baselines.get(width) ?? null,
    screenHeight: orientedScreenHeight(),
  });
}

let snapshot = false;

function subscribe(cb: () => void): () => void {
  const update = () => {
    const next = compute();
    if (next !== snapshot) {
      snapshot = next;
      cb();
    }
  };
  const deferred = () => setTimeout(update, 0);
  const vv = window.visualViewport;
  vv?.addEventListener("resize", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", deferred);
  update();
  return () => {
    vv?.removeEventListener("resize", update);
    window.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", deferred);
  };
}

export function useComposingWithKeyboard(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => false,
  );
}
