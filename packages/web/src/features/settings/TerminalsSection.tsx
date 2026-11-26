import type { Terminal, TerminalBindingInput } from "@switchyard/protocol";
import { terminalMirror, terminalOpen } from "@switchyard/protocol";
import { SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { Select } from "../../components/ui/Select";
import { EmptyState, LastKnownNote, LoadingState } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiPut, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { SectionPage, useHydrated } from "./shared";

/** The select value for a terminal's binding: "none", "all" or "view:<id>". */
export function bindingValue(t: Pick<Terminal, "mirror" | "viewId">): string {
  const m = terminalMirror(t);
  return m === "view" ? `view:${t.viewId}` : m;
}

export function bindingFromValue(value: string): TerminalBindingInput {
  if (value.startsWith("view:")) return { mirror: "view", viewId: value.slice(5) };
  return { mirror: value === "all" ? "all" : "none" };
}

/** Settings › Terminals: herdr and tmux sessions, and what each one mirrors. */
export function TerminalsSection() {
  const hydrated = useHydrated();
  const byId = useSyncStore((s) => s.terminals);
  const views = useSyncStore((s) => s.views);
  const hosts = useSyncStore((s) => s.hosts);
  const [busy, setBusy] = useState<string | null>(null);
  const terminals = useMemo(
    () =>
      Object.values(byId).sort(
        (a, b) => a.machine.localeCompare(b.machine) || a.id.localeCompare(b.id),
      ),
    [byId],
  );
  const viewList = useMemo(
    () => Object.values(views).sort((a, b) => a.name.localeCompare(b.name)),
    [views],
  );

  const bind = async (t: Terminal, value: string) => {
    setBusy(t.id);
    try {
      await apiPut(`/api/terminals/${encodeURIComponent(t.id)}/binding`, bindingFromValue(value));
    } catch (e) {
      toast.error(`Could not change ${t.kind} ${t.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionPage
      testId="settings-terminals"
      title="Terminals"
      description="herdr and tmux sessions running the Switchyard plugin. Each one mirrors nothing, every session, or one view: a tab or window per active branch. Pi you start by hand in any of them shows up either way."
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading terminals…" />
      ) : terminals.length === 0 ? (
        <EmptyState
          icon={<SquareTerminal className="size-8" />}
          title="No terminals"
          description="A herdr or tmux session appears here once the Switchyard plugin runs in it, or after switchyard terminals bind."
        />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {terminals.map((t) => {
            const value = bindingValue(t);
            const viewGone = value.startsWith("view:") && !views[t.viewId ?? ""];
            const where = (t.hostId && hosts[t.hostId]?.name) || t.machine;
            return (
              <li
                key={t.id}
                data-testid="terminal-row"
                className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <SquareTerminal aria-hidden className="size-5 shrink-0 text-muted" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="min-w-0 break-words font-medium">
                    {t.kind} {t.name}
                  </span>
                  <span className="text-sm text-muted">
                    on {where} ·{" "}
                    {terminalOpen(t)
                      ? `seen ${formatRelative(t.lastSeenAt)}`
                      : "plugin not running"}
                    {(t.shows?.length ?? 0) > 0 && ` · ${t.shows!.length} mirrored`}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span aria-hidden className="text-muted">
                    Mirrors
                  </span>
                  <Select
                    width="auto"
                    aria-label={`What ${t.kind} ${t.name} mirrors`}
                    value={value}
                    disabled={busy === t.id}
                    onChange={(e) => void bind(t, e.target.value)}
                  >
                    <option value="none">Nothing</option>
                    <option value="all">Everything</option>
                    {viewList.map((v) => (
                      <option key={v.id} value={`view:${v.id}`}>
                        View: {v.name}
                      </option>
                    ))}
                    {viewGone && <option value={value}>Deleted view</option>}
                  </Select>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionPage>
  );
}
