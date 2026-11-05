import type { Automation } from "@switchyard/protocol";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { create } from "zustand";
import { toast } from "../../components/ui/Toast";
import { apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";

/* Small building blocks shared by the Automations list and editor. */

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
