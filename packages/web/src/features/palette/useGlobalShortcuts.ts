import { useEffect } from "react";
import { useNavigate } from "react-router";
import { usePalette } from "./registry";
import { matchShortcut } from "./shortcuts";

export const TOGGLE_TERMINAL_EVENT = "sy:toggle-terminal";

/** One window keydown listener for every global shortcut. */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e, mac);
      if (!id) return;
      if (id !== "palette" && e.target instanceof Element && e.target.closest(".xterm")) return;
      e.preventDefault();
      switch (id) {
        case "palette":
          usePalette.getState().setOpen(!usePalette.getState().open);
          return;
        case "newSession":
          navigate("/code", { state: { newSession: true } });
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}
