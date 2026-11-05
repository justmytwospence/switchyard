import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { create } from "zustand";
import { cn } from "../../lib/cn";

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

interface ToastStore {
  toasts: ToastItem[];
  push(t: Omit<ToastItem, "id">, durationMs?: number): number;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push(t, durationMs = 4000) {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (durationMs > 0) setTimeout(() => get().dismiss(id), durationMs);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Show a toast from anywhere (mutation feedback). */
export const toast = {
  success: (message: string, action?: ToastItem["action"]) =>
    useToasts.getState().push({ message, tone: "success", action }),
  error: (message: string, action?: ToastItem["action"]) =>
    useToasts.getState().push({ message, tone: "error", action }, 7000),
  info: (message: string, action?: ToastItem["action"]) =>
    useToasts.getState().push({ message, tone: "info", action }),
};

const ICONS = { success: CircleCheck, error: CircleX, info: Info };

/** Toast region; mounted once by the app shell. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+0.5rem)] z-[60] flex flex-col items-center gap-2 px-3 md:top-auto md:bottom-[calc(var(--safe-bottom)+1rem)] md:items-end md:px-4"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-pop",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                t.tone === "success" && "text-success",
                t.tone === "error" && "text-danger",
                t.tone === "info" && "text-info",
              )}
            />
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="tap rounded px-2 py-1 font-medium text-accent hover:bg-surface-2"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              className="tap inline-flex size-7 items-center justify-center rounded text-muted hover:bg-surface-2"
              onClick={() => dismiss(t.id)}
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
