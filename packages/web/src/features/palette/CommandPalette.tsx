import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/ui/Overlay";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { sessionsNeedingAttention } from "../../sync/selectors";
import { useSyncStore } from "../../sync/store";
import { statusBucket } from "../code/model";
import { emptyQueryItems, rankItems } from "./match";
import { type PaletteItem, usePalette } from "./registry";
import { formatShortcut, SHORTCUTS } from "./shortcuts";
import { useGlobalItems } from "./useGlobalItems";

const RECENT_KEY = "sy:palette:recent";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Cmd+K: jump to a session, task, project, host or setting, or run an action. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const providers = usePalette((s) => s.providers);
  const global = useGlobalItems();
  const sessions = useSyncStore((s) => s.sessions);
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo(() => [...global, ...Object.values(providers).flat()], [global, providers]);
  const rows: { label?: string; item: PaletteItem }[] = useMemo(() => {
    if (!open) return [];
    if (query.trim())
      return rankItems(items, query, loadRecent())
        .slice(0, 50)
        .map((item) => ({ item }));
    const needsYou = sessionsNeedingAttention(attention, interactions);
    const review = new Set(
      Object.values(sessions)
        .filter((s) => statusBucket(s, false) === "review")
        .map((s) => s.id),
    );
    return emptyQueryItems(items, { needsYou, review }).flatMap((sec) =>
      sec.items.map((item, i) => ({ item, label: i === 0 ? sec.label : undefined })),
    );
  }, [open, query, items, attention, interactions, sessions]);

  const run = (item: PaletteItem) => {
    try {
      localStorage.setItem(
        RECENT_KEY,
        JSON.stringify([item.id, ...loadRecent().filter((i) => i !== item.id)].slice(0, 20)),
      );
    } catch {
      // ignore
    }
    setOpen(false);
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[active];
      if (r) run(r.item);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Command palette"
      initialFocus={input}
      bodyClassName="p-0"
    >
      <div className="flex flex-col gap-2">
        <TextInput
          ref={input}
          value={query}
          placeholder="Search sessions, tasks, settings and actions"
          aria-label="Search"
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto">
          {rows.length === 0 && <p className="px-2 py-4 text-sm text-muted">No matches.</p>}
          {rows.map(({ item, label }, i) => (
            <div key={item.id}>
              {label && <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted">{label}</p>}
              <div
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                data-testid="palette-item"
                onMouseMove={() => setActive(i)}
                onClick={() => run(item)}
                onKeyDown={() => {}}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm",
                  i === active && "bg-surface-2",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.subtitle && (
                  <span className="hidden truncate text-xs text-muted sm:inline">
                    {item.subtitle}
                  </span>
                )}
                <span className="shrink-0 text-xs text-subtle">{item.group}</span>
                {item.shortcut && (
                  <kbd className="shrink-0 text-xs text-muted">
                    {formatShortcut(
                      SHORTCUTS[item.shortcut].keys.find((k) => k.startsWith("Alt")) ??
                        SHORTCUTS[item.shortcut].keys[0]!,
                      isMac(),
                    )}
                  </kbd>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
