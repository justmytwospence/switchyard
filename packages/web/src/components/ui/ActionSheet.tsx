import { Check } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useDragDismiss } from "../../lib/useDragDismiss";
import type { MenuHeading, MenuItem } from "./Menu";
import { useFocusTrap, useScrollLock } from "./useFocusTrap";

type Entry = MenuItem | MenuHeading | "separator";

interface Group {
  key: string;
  heading?: string;
  items: MenuItem[];
}

/**
 * Split a menu into the grouped cards of a native action sheet. Separators and headings start a
 * group. A flat list is grouped by kind instead: actions, then settings (checkbox and radio
 * items), then destructive actions last, nearest the thumb's Cancel.
 */
export function groupItems(items: Entry[]): Group[] {
  const structured = items.some((i) => i === "separator" || "heading" in i);
  if (!structured) {
    const plain = items as MenuItem[];
    return [
      { key: "actions", items: plain.filter((i) => !i.kind && !i.danger) },
      { key: "settings", items: plain.filter((i) => i.kind && !i.danger) },
      { key: "danger", items: plain.filter((i) => i.danger) },
    ].filter((g) => g.items.length > 0);
  }
  const groups: Group[] = [];
  let current: Group = { key: "g0", items: [] };
  const flush = () => {
    if (current.items.length > 0) groups.push(current);
  };
  for (const [i, item] of items.entries()) {
    if (item === "separator") {
      flush();
      current = { key: `g${i}`, items: [] };
    } else if ("heading" in item) {
      flush();
      current = { key: item.id, heading: item.heading, items: [] };
    } else current.items.push(item);
  }
  flush();
  return groups;
}

/**
 * A menu as a native-style bottom sheet: the phone presentation of `Menu` and of long-press
 * actions. Grouped rounded cards, a Cancel button within thumb reach, drag down to close.
 */
export function ActionSheet({
  open,
  onClose,
  title,
  description,
  items,
  label,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  items: Entry[];
  label: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(panel, open, onClose, panel);
  useScrollLock(open);
  useDragDismiss(panel, open, onClose);
  if (!open) return null;
  const groups = groupItems(items);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="sy-fade-in absolute inset-0 bg-overlay" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="sy-sheet-in relative flex max-h-[85dvh] w-full max-w-md flex-col gap-2 px-2 pb-[calc(var(--safe-bottom)+0.5rem)] outline-none select-none [-webkit-touch-callout:none]"
      >
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-surface shadow-pop">
          <div className="flex shrink-0 justify-center pt-2 pb-1" aria-hidden>
            <div className="h-1 w-9 rounded-full bg-border-strong" />
          </div>
          {(title || description) && (
            <div className="shrink-0 px-6 pb-2 text-center">
              {title && <p className="truncate text-sm font-semibold">{title}</p>}
              {description && <p className="truncate text-xs text-muted">{description}</p>}
            </div>
          )}
          <div
            role="menu"
            aria-label={label}
            data-testid="action-sheet"
            data-sheet-scroll
            className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pt-1 pb-3"
          >
            {groups.map((g) => {
              const icons = g.items.some((i) => i.icon && !i.kind);
              return (
                <div key={g.key}>
                  {g.heading && (
                    <p className="px-3 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
                      {g.heading}
                    </p>
                  )}
                  <div className="overflow-hidden rounded-xl bg-surface-2">
                    {g.items.map((item, i) => (
                      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is only set with the menuitemradio/menuitemcheckbox roles
                      <button
                        key={item.id}
                        type="button"
                        role={
                          item.kind === "radio"
                            ? "menuitemradio"
                            : item.kind === "checkbox"
                              ? "menuitemcheckbox"
                              : "menuitem"
                        }
                        aria-checked={item.kind ? !!item.checked : undefined}
                        aria-describedby={item.description ? `${id}-${item.id}-desc` : undefined}
                        disabled={item.disabled}
                        className={cn(
                          "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] leading-5 outline-none",
                          "active:bg-surface-3 focus-visible:bg-surface-3 disabled:opacity-45",
                          i > 0 && "border-t border-border",
                          item.danger ? "text-danger" : "text-text",
                        )}
                        onClick={() => {
                          // Synchronously, so file pickers and dialogs still have the user gesture.
                          onClose();
                          item.onSelect();
                        }}
                      >
                        {icons && (
                          <span
                            aria-hidden
                            className={cn(
                              "flex size-5 shrink-0 items-center justify-center [&>svg]:size-[18px]",
                              !item.danger && "text-muted",
                            )}
                          >
                            {!item.kind && item.icon}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block">{item.label}</span>
                          {item.hint && (
                            <span className="block text-xs leading-4 text-muted">{item.hint}</span>
                          )}
                          {item.description && (
                            <span id={`${id}-${item.id}-desc`} hidden>
                              {item.description}
                            </span>
                          )}
                        </span>
                        {item.kind === "checkbox" && <Toggle on={!!item.checked} />}
                        {item.kind === "radio" && item.checked && (
                          <Check aria-hidden className="size-5 shrink-0 text-accent" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-13 w-full shrink-0 rounded-2xl bg-surface text-[15px] font-semibold text-accent shadow-pop active:bg-surface-2"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** A switch-shaped indicator for checkbox items (the row itself is the control). */
function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors",
        on ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </span>
  );
}
