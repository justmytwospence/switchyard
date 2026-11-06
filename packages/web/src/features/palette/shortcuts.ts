export type ShortcutId =
  | "palette"
  | "newSession"
  | "goCode"
  | "goBoard"
  | "goAttention"
  | "goSettings"
  | "toggleTerminal";

/** The one shortcut table. `Mod` is Cmd on Mac and Ctrl elsewhere; keys are `KeyboardEvent.code`. */
export const SHORTCUTS: Record<ShortcutId, { label: string; keys: string[] }> = {
  palette: { label: "Command palette", keys: ["Mod+KeyK", "Alt+KeyK"] },
  newSession: { label: "New session", keys: ["Alt+KeyN"] },
  goCode: { label: "Go to Code", keys: ["Alt+Digit1"] },
  goBoard: { label: "Go to Board", keys: ["Alt+Digit2"] },
  goAttention: { label: "Go to Attention", keys: ["Alt+Digit3"] },
  goSettings: { label: "Go to Settings", keys: ["Alt+Comma"] },
  toggleTerminal: { label: "Toggle terminal", keys: ["Alt+KeyT"] },
};

interface KeyEventLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function matchShortcut(e: KeyEventLike, isMac: boolean): ShortcutId | null {
  for (const [id, def] of Object.entries(SHORTCUTS) as [
    ShortcutId,
    (typeof SHORTCUTS)[ShortcutId],
  ][]) {
    for (const combo of def.keys) {
      const parts = combo.split("+");
      const code = parts[parts.length - 1];
      const mods = new Set(parts.slice(0, -1));
      const wantMeta = mods.has("Mod") && isMac;
      const wantCtrl = mods.has("Mod") && !isMac;
      const wantAlt = mods.has("Alt");
      if (
        e.code === code &&
        e.metaKey === wantMeta &&
        e.ctrlKey === wantCtrl &&
        e.altKey === wantAlt &&
        !e.shiftKey
      ) {
        return id;
      }
    }
  }
  return null;
}

export function formatShortcut(keys: string, isMac: boolean): string {
  const parts = keys.split("+");
  const code = parts[parts.length - 1] ?? "";
  const key = code.startsWith("Key")
    ? code.slice(3)
    : code.startsWith("Digit")
      ? code.slice(5)
      : code === "Comma"
        ? ","
        : code;
  const mods = parts
    .slice(0, -1)
    .map((m) => (m === "Mod" ? (isMac ? "⌘" : "Ctrl+") : isMac ? "⌥" : "Alt+"));
  return `${mods.join("")}${key}`;
}
