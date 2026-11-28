import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { hasKeyboardLayer } from "../../components/ui/keyboardLayers";
import { usePrefs } from "../../prefs";
import { handleNavigationAction } from "./navigation";
import { usePalette } from "./registry";
import { matchNavigationKey, matchShortcut } from "./shortcuts";

export const TOGGLE_TERMINAL_EVENT = "sy:toggle-terminal";

function editable(target: Element | null): boolean {
  return !!target?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  );
}

/** One window keydown listener for modifier shortcuts and navigation-only Vim keys. */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes reset an unfinished g sequence
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    let pendingG: number | null = null;
    const reset = () => {
      pendingG = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.key === "Process") {
        reset();
        return;
      }
      if (hasKeyboardLayer()) {
        reset();
        return;
      }
      const target = e.target instanceof HTMLElement ? e.target : null;
      const terminal = !!target?.closest(".xterm, iframe, [data-keyboard-ignore]");
      const id = matchShortcut(e, mac);
      if (id) {
        reset();
        if (id !== "palette" && terminal) return;
        e.preventDefault();
        switch (id) {
          case "palette":
            usePalette.getState().setOpen(true);
            return;
          case "newSession":
            navigate("/code", { state: { newSession: true, mode: "prompt" } });
            return;
          case "goCode":
            navigate("/code");
            return;
          case "goBoard":
            navigate("/board");
            return;
          case "goAttention":
            navigate("/attention");
            return;
          case "goSettings":
            navigate("/settings");
            return;
          case "toggleTerminal":
            window.dispatchEvent(new CustomEvent(TOGGLE_TERMINAL_EVENT));
            return;
        }
      }
      if (e.key === "Escape") {
        reset();
        if (target && editable(target) && !terminal) {
          e.preventDefault();
          (
            target.closest<HTMLElement>("[data-keyboard-pane], [data-keyboard-scope]") ??
            document.querySelector<HTMLElement>("main")
          )?.focus({ preventScroll: true });
        }
        return;
      }
      if (!usePrefs.getState().vimNavigation || terminal) {
        reset();
        return;
      }
      if (editable(target)) {
        reset();
        return;
      }
      // A focused control owns its own keys unless it is a marked primary navigation item.
      if (
        target?.closest("[role='radio'], [role='slider'], [role='switch'], [data-keyboard-ignore]")
      ) {
        reset();
        return;
      }
      if (
        target?.closest("a, button, [role='button']") &&
        !target.closest("[data-keyboard-item]")
      ) {
        if (["j", "k", "h", "l", "G"].includes(e.key)) {
          reset();
          return;
        }
      }
      const matched = matchNavigationKey(e, { pendingG, now: Date.now() });
      pendingG = matched.pendingG;
      if (!matched.handled) return;
      if (!matched.action) {
        e.preventDefault();
        return;
      }
      const routes = {
        goCode: "/code",
        goBoard: "/board",
        goAttention: "/attention",
        goTasks: "/tasks",
        goQueue: "/queue",
        goAutomations: "/automations",
        goSettings: "/settings",
      } as const;
      if (matched.action in routes) {
        e.preventDefault();
        navigate(routes[matched.action as keyof typeof routes]);
        return;
      }
      if (matched.action === "help") {
        e.preventDefault();
        usePalette.getState().setHelpOpen(true);
        return;
      }
      if (matched.action === "search") {
        e.preventDefault();
        if (!handleNavigationAction("search", target)) usePalette.getState().setOpen(true);
        return;
      }
      if (handleNavigationAction(matched.action, target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", reset);
    window.addEventListener("pointerdown", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", reset);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("blur", reset);
    };
  }, [navigate, pathname]);
}
