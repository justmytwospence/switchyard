import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Short explanation shown under the label (e.g. why it is disabled). */
  hint?: string;
}

export interface MenuProps {
  /** Render the trigger; spread the given props onto a button. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
  }) => ReactNode;
  items: (MenuItem | "separator")[];
  align?: "start" | "end";
  /** Accessible name of the menu. */
  label: string;
}

/** Popup menu with arrow-key navigation, Escape and outside click to close. */
export function Menu({ trigger, items, align = "end", label }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const focusItem = (dir: 1 | -1 | "first" | "last") => focusMenuItem(menuRef.current, dir);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => focusMenuItem(menuRef.current, "first"));
    const onDoc = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  return (
    <div className="relative inline-flex">
      {trigger({
        ref: btnRef,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
      })}
      {open && (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "absolute top-full z-40 mt-1 min-w-48 max-w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface py-1 shadow-pop",
            align === "end" ? "right-0" : "left-0",
          )}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusItem(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusItem(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              focusItem("first");
            } else if (e.key === "End") {
              e.preventDefault();
              focusItem("last");
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
        >
          {items.map((item, i) =>
            item === "separator" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
              <hr key={`sep-${i}`} className="my-1 border-t border-border" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  "tap flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:opacity-55",
                  item.danger ? "text-danger" : "text-text",
                )}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.icon && <span className="mt-0.5 shrink-0">{item.icon}</span>}
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  {item.hint && <span className="block text-xs text-muted">{item.hint}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function focusMenuItem(menu: HTMLElement | null, dir: 1 | -1 | "first" | "last"): void {
  const els = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
  if (els.length === 0) return;
  const idx = els.indexOf(document.activeElement as HTMLElement);
  let next = 0;
  if (dir === "first") next = 0;
  else if (dir === "last") next = els.length - 1;
  else next = (idx + dir + els.length) % els.length;
  els[next]!.focus();
}
