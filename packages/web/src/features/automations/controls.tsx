import type { Automation, Priority } from "@switchyard/protocol";
import {
  CircleCheck,
  CloudOff,
  OctagonAlert,
  SignalHigh,
  SignalLow,
  SignalMedium,
  TriangleAlert,
} from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import { create } from "zustand";
import { Spinner } from "../../components/ui/Button";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/time";
import { apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useConnection, useSyncStore } from "../../sync/store";

/* Small building blocks shared by the Automations list and editor. */

export interface FieldControlProps {
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/** Labelled form field with an optional hint and inline error. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (props: FieldControlProps) => ReactElement;
  className?: string;
  optional?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy || undefined,
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && <FieldError id={errId}>{error}</FieldError>}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1 text-xs text-danger" data-field-error>
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Native select styled like TextInput. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "tap block h-9 w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-base text-text md:text-sm",
        "focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0",
        "aria-[invalid=true]:border-danger",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/** Accessible on/off switch with a text label that states the current value. */
export function Switch({
  checked,
  onChange,
  label,
  onText = "On",
  offText = "Off",
  busy,
  disabled,
  id,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. */
  label: string;
  onText?: string;
  offText?: string;
  busy?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        "tap inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md px-1.5 text-sm",
        "hover:bg-surface-2 disabled:opacity-60",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface-2",
        )}
      >
        <span
          className={cn(
            "absolute size-3.5 rounded-full shadow-sm transition-transform",
            checked ? "translate-x-[18px] bg-accent-fg" : "translate-x-[2px] bg-muted",
          )}
        />
      </span>
      {busy ? <Spinner className="size-3.5" /> : null}
      <span className={checked ? "text-text" : "text-muted"}>{checked ? onText : offText}</span>
    </button>
  );
}

/** Titled card section. */
export function Section({
  title,
  description,
  children,
  actions,
  className,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={cn("min-w-0 rounded-lg border border-border bg-surface p-4", className)}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

const PRIORITY_ICONS = [OctagonAlert, SignalHigh, SignalMedium, SignalLow];

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const Icon = PRIORITY_ICONS[priority] ?? SignalMedium;
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", priority === 0 ? "text-danger" : "text-muted", className)}
    />
  );
}

/** Failure count as icon + text; warning tone when > 0. */
export function FailureCount({ count }: { count: number }) {
  if (count > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-warning">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {count === 1 ? "1 failure" : `${count} failures`}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm text-muted">
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      No failures
    </span>
  );
}

/** Inline last-known-data note when the coordinator link is not live. */
export function ConnectionNote({ className }: { className?: string }) {
  const connection = useConnection();
  if (connection.state === "live") return null;
  if (connection.state === "connecting" && !connection.lastSyncedAt) return null;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-1.5 rounded-md border border-border bg-warning-soft px-3 py-1.5 text-sm",
        className,
      )}
    >
      <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        Showing last known automations
        {connection.lastSyncedAt ? ` from ${formatTime(connection.lastSyncedAt)}` : ""}. Changes are
        sent once the coordinator is reachable again.
      </span>
    </p>
  );
}

export const automationPath = (id: string, suffix = "") =>
  `/api/automations/${encodeURIComponent(id)}${suffix}`;

/* ------------------------------------------------------------------ */
/* Automations acknowledged over REST (create/patch responses, list    */
/* fallback) so views do not wait for the automation.updated event.    */
/* ------------------------------------------------------------------ */

interface LocalAutomations {
  byId: Record<string, Automation>;
  deleted: Record<string, true>;
  put(a: Automation): void;
  putMany(list: Automation[]): void;
  remove(id: string): void;
}

export const useLocalAutomations = create<LocalAutomations>()((set) => ({
  byId: {},
  deleted: {},
  put: (a) => set((s) => ({ byId: { ...s.byId, [a.id]: a } })),
  putMany: (list) =>
    set((s) => {
      const byId = { ...s.byId };
      for (const a of list) byId[a.id] = a;
      return { byId };
    }),
  remove: (id) =>
    set((s) => {
      const byId = { ...s.byId };
      delete byId[id];
      return { byId, deleted: { ...s.deleted, [id]: true } };
    }),
}));

function newer(a: Automation | undefined, b: Automation | undefined): Automation | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** Store automations merged with REST acknowledgements (newest updatedAt wins). */
export function useMergedAutomations(): Record<string, Automation> {
  const store = useSyncStore((s) => s.automations);
  const local = useLocalAutomations((s) => s.byId);
  const deleted = useLocalAutomations((s) => s.deleted);
  return useMemo(() => {
    const out: Record<string, Automation> = {};
    for (const id of new Set([...Object.keys(store), ...Object.keys(local)])) {
      if (deleted[id]) continue;
      const a = newer(store[id], local[id]);
      if (a) out[id] = a;
    }
    return out;
  }, [store, local, deleted]);
}

export function useMergedAutomation(id: string | undefined): Automation | undefined {
  const fromStore = useSyncStore((s) => (id ? s.automations[id] : undefined));
  const fromLocal = useLocalAutomations((s) => (id ? s.byId[id] : undefined));
  const deleted = useLocalAutomations((s) => (id ? s.deleted[id] : undefined));
  return deleted ? undefined : newer(fromStore, fromLocal);
}

/** Enable/disable with no optimistic success: busy until the coordinator acknowledges. */
export function useToggleEnabled() {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const toggle = useCallback(async (a: Pick<Automation, "id" | "name">, enabled: boolean) => {
    setBusy((b) => ({ ...b, [a.id]: true }));
    try {
      const res = await apiPatch<Automation | undefined>(automationPath(a.id), { enabled });
      if (res && typeof res === "object" && "id" in res) useLocalAutomations.getState().put(res);
      toast.success(`${a.name} ${enabled ? "enabled" : "disabled"}`);
    } catch (e) {
      toast.error(`Could not ${enabled ? "enable" : "disable"} ${a.name}: ${errorMessage(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [a.id]: false }));
    }
  }, []);
  return { busy, toggle };
}

/** Manual "Run now": busy until acknowledged; never reports success early. */
export function useRunNow(onDone?: () => void) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const run = useCallback(
    async (a: Pick<Automation, "id" | "name">) => {
      setBusy((b) => ({ ...b, [a.id]: true }));
      try {
        const res = await apiPost<{ state?: string } | undefined>(automationPath(a.id, "/run"));
        const state = res && typeof res === "object" ? res.state : undefined;
        toast.success(
          state && state !== "fired"
            ? `${a.name}: occurrence recorded (${state.replace(/_/g, " ")})`
            : `${a.name} started`,
        );
        onDone?.();
      } catch (e) {
        toast.error(`Could not run ${a.name}: ${errorMessage(e)}`);
      } finally {
        setBusy((b) => ({ ...b, [a.id]: false }));
      }
    },
    [onDone],
  );
  return { busy, run };
}
