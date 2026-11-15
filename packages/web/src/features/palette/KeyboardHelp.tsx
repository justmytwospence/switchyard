import { Dialog } from "../../components/ui/Overlay";
import { usePrefs } from "../../prefs";
import { isMac } from "./CommandPalette";
import { usePalette } from "./registry";
import { formatShortcut, NAVIGATION_SHORTCUTS, SHORTCUTS } from "./shortcuts";

export function KeyboardHelp() {
  const open = usePalette((s) => s.helpOpen);
  const setOpen = usePalette((s) => s.setHelpOpen);
  const vim = usePrefs((s) => s.vimNavigation);
  const set = usePrefs((s) => s.set);
  const mac = isMac();
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div className="space-y-5 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={vim}
            onChange={(e) => set("vimNavigation", e.target.checked)}
          />
          Vim-style navigation
        </label>
        <p className="text-muted">
          Text fields keep normal editing and terminals own their keys. Enter activates only a
          focused control; Escape dismisses overlays or leaves a field without clearing drafts.
        </p>
        <section aria-label="Global shortcuts">
          <h3 className="mb-2 font-semibold">Global</h3>
          <ul className="space-y-1">
            {Object.values(SHORTCUTS).map((entry) => (
              <li key={entry.label} className="flex justify-between gap-4">
                <span>{entry.label}</span>
                <kbd className="shrink-0 text-muted">
                  {entry.keys.map((key) => formatShortcut(key, mac)).join(" / ")}
                </kbd>
              </li>
            ))}
            <li className="flex justify-between gap-4">
              <span>Dismiss top overlay / leave a field</span>
              <kbd className="text-muted">Esc</kbd>
            </li>
          </ul>
        </section>
        {(["Global", "Navigation", "Code"] as const).map((group) => (
          <section
            key={group}
            aria-label={`${group} Vim shortcuts`}
            className={vim ? "" : "opacity-50"}
          >
            <h3 className="mb-2 font-semibold">
              {group === "Global" ? "Vim destinations" : group}
            </h3>
            <ul className="space-y-1">
              {NAVIGATION_SHORTCUTS.filter((entry) => entry.context === group).map((entry) => (
                <li key={entry.action} className="flex justify-between gap-4">
                  <span>{entry.label}</span>
                  <kbd className="shrink-0 text-muted">{entry.keys}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section aria-label="Palette and widgets">
          <h3 className="mb-2 font-semibold">Palette and widgets</h3>
          <ul className="space-y-1">
            <li className="flex justify-between gap-4">
              <span>Next / previous palette result</span>
              <kbd className="text-muted">Ctrl+j/n · Ctrl+k/p</kbd>
            </li>
            <li className="flex justify-between gap-4">
              <span>Activate a focused result</span>
              <kbd className="text-muted">Enter</kbd>
            </li>
            <li className="flex justify-between gap-4">
              <span>Move through tabs or files</span>
              <kbd className="text-muted">Arrows</kbd>
            </li>
            <li className="flex justify-between gap-4">
              <span>Move between controls</span>
              <kbd className="text-muted">Tab / Shift+Tab</kbd>
            </li>
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
