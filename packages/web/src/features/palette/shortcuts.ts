export type NavigationAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "left"
  | "right"
  | "search"
  | "composer"
  | "help"
  | "halfDown"
  | "halfUp"
  | "goCode"
  | "goBoard"
  | "goAttention"
  | "goQueue"
  | "goAutomations"
  | "goSettings";

export const NAVIGATION_SHORTCUTS: readonly {
  action: NavigationAction;
  label: string;
  keys: string;
  context: "Global" | "Navigation" | "Code";
}[] = [
  { action: "help", label: "Keyboard shortcuts", keys: "?", context: "Global" },
  { action: "search", label: "Search this view", keys: "/", context: "Global" },
  { action: "goCode", label: "Go to Code", keys: "g c", context: "Global" },
  { action: "goBoard", label: "Go to Board", keys: "g b", context: "Global" },
  { action: "goAttention", label: "Go to Attention", keys: "g a", context: "Global" },
  { action: "goQueue", label: "Go to Queue", keys: "g q", context: "Global" },
  { action: "goAutomations", label: "Go to Automations", keys: "g o", context: "Global" },
  { action: "goSettings", label: "Go to Settings", keys: "g s", context: "Global" },
  { action: "next", label: "Next item", keys: "j", context: "Navigation" },
  { action: "previous", label: "Previous item", keys: "k", context: "Navigation" },
  { action: "first", label: "First item / transcript top", keys: "g g", context: "Navigation" },
  { action: "last", label: "Last item / transcript bottom", keys: "G", context: "Navigation" },
  { action: "left", label: "Previous pane / column", keys: "h", context: "Navigation" },
  { action: "right", label: "Next pane / column", keys: "l", context: "Navigation" },
  { action: "composer", label: "Focus the composer", keys: "i", context: "Code" },
  {
    action: "halfDown",
    label: "Scroll transcript down half a page",
    keys: "Ctrl+d",
    context: "Code",
  },
  { action: "halfUp", label: "Scroll transcript up half a page", keys: "Ctrl+u", context: "Code" },
];

const GO_KEYS: Record<string, NavigationAction> = {
  c: "goCode",
  b: "goBoard",
  a: "goAttention",
  q: "goQueue",
  o: "goAutomations",
  s: "goSettings",
  g: "first",
};

interface NavigationKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

export function matchNavigationKey(
  e: NavigationKeyLike,
  state: { pendingG: number | null; now: number },
): { action: NavigationAction | null; pendingG: number | null; handled: boolean } {
  const none = { action: null, pendingG: null, handled: false } as const;
  if (
    e.isComposing ||
    e.defaultPrevented ||
    e.altKey ||
    e.metaKey ||
    (e.shiftKey && e.key !== "G" && e.key !== "?")
  )
    return none;
  if (e.ctrlKey) {
    if (e.shiftKey) return none;
    const action =
      e.key.toLowerCase() === "d" ? "halfDown" : e.key.toLowerCase() === "u" ? "halfUp" : null;
    return action ? { action, pendingG: null, handled: true } : none;
  }
  if (state.pendingG !== null && state.now - state.pendingG < 800) {
    const action = !e.repeat && !e.shiftKey ? (GO_KEYS[e.key] ?? null) : null;
    return action ? { action, pendingG: null, handled: true } : none;
  }
  if (e.key === "g" && !e.repeat) return { action: null, pendingG: state.now, handled: true };
  const actions: Record<string, NavigationAction> = {
    j: "next",
    k: "previous",
    h: "left",
    l: "right",
    G: "last",
    "/": "search",
    i: "composer",
    "?": "help",
  };
  const action = actions[e.key] ?? null;
  return action ? { action, pendingG: null, handled: true } : none;
}

export function verticalNavigationDelta(key: string, enabled: boolean): number {
  if (key === "ArrowDown" || (enabled && key === "j")) return 1;
  if (key === "ArrowUp" || (enabled && key === "k")) return -1;
  return 0;
}

export function horizontalNavigationDelta(key: string, enabled: boolean): number {
  if (key === "ArrowRight" || (enabled && key === "l")) return 1;
  if (key === "ArrowLeft" || (enabled && key === "h")) return -1;
  return 0;
}

export function paletteNavigationDelta(e: NavigationKeyLike): number {
  const ctrl = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === "ArrowDown" || (ctrl && (e.key === "j" || e.key === "n"))) return 1;
  if (e.key === "ArrowUp" || (ctrl && (e.key === "k" || e.key === "p"))) return -1;
  return 0;
}

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
