import { useSyncExternalStore } from "react";

/**
 * True while the on-screen keyboard is up for a text field: the visual
 * viewport is under 75% of the layout viewport and focus is in a textarea or
 * text input. The bottom nav hides then (spec 10).
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

function compute(): boolean {
  if (typeof window === "undefined") return false;
  const vv = window.visualViewport;
  if (!vv) return false;
  return vv.height < window.innerHeight * 0.75 && isTextField(document.activeElement);
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
