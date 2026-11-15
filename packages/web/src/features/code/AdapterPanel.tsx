import type { Panel } from "@switchyard/protocol";
import { useState } from "react";
import { CustomFrame } from "../../components/intent/CustomFrame";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { UnsupportedCapability } from "../../components/ui/states";
import { errorMessage } from "../../sync/api";
import { codeApi } from "./api";
import { useCodeContext } from "./context";
import type { SessionContext } from "./hooks";

/** Missing generations are legacy hosts, not generation zero. */
export function isAdapterViewStale(rendered?: string, current?: string): boolean {
  return rendered !== undefined && current !== undefined && rendered !== current;
}

export const STALE_ADAPTER_VIEW = "This extension view changed. Reopen it before trying again.";

/** Portable panels may render anywhere; sandboxed frames are restricted to the inspector. */
export function AdapterPanel({
  ctx,
  panel,
  allowFrame = false,
}: {
  ctx: SessionContext;
  panel: Panel;
  allowFrame?: boolean;
}) {
  const { mobile, openFile } = useCodeContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = isAdapterViewStale(panel.adapterGeneration, ctx.session.adapterGeneration);
  const disabled =
    stale || ctx.session.readOnly || ctx.session.archivedAt !== null || ctx.link !== "connected";
  const action = async (id: string, payload?: unknown) => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await codeApi.adapterAction(
        ctx.session.id,
        panel.adapterId,
        id,
        payload,
        panel.adapterGeneration,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const available = ctx.adapters.some(
    (adapter) =>
      adapter.id === panel.adapterId && adapter.status === "active" && adapter.webRenderer,
  );
  const frame = allowFrame && panel.webRenderer && !mobile && !!ctx.host && available && !disabled;
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
      <header className="flex min-w-0 items-baseline gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium" title={panel.title}>
          {panel.title}
        </h4>
        <span className="shrink-0 font-mono text-xs text-subtle">{panel.adapterId}</span>
      </header>
      {frame ? (
        <CustomFrame
          hostId={ctx.session.hostId}
          adapterId={panel.adapterId}
          node={panel.node}
          state={panel.state}
          title={panel.title}
          onAction={(id, payload) => void action(id, payload)}
        />
      ) : panel.node ? (
        <>
          {allowFrame && panel.webRenderer && mobile && (
            <p className="text-xs text-muted">
              Showing the portable version; this panel&apos;s custom renderer is desktop-only.
            </p>
          )}
          <UINodeRenderer
            node={panel.node}
            onOpenFile={openFile}
            busy={busy}
            disabled={disabled}
            onAction={(id) => void action(id)}
            onRespond={
              panel.contribution
                ? (response) => {
                    if (response.kind === "cancel") return;
                    if (response.kind === "action") {
                      void action(response.actionId);
                      return;
                    }
                    if (panel.contribution?.actionId)
                      void action(panel.contribution.actionId, response);
                  }
                : undefined
            }
          />
        </>
      ) : (
        <UnsupportedCapability
          capability="This panel"
          reason={
            mobile ? "Its custom renderer is desktop-only." : "Its custom renderer is unavailable."
          }
          fallback={
            <p className="text-sm">
              {panel.mobileFallback ?? "The adapter provides no portable fallback."}
            </p>
          }
        />
      )}
      {stale && <p className="text-sm text-muted">{STALE_ADAPTER_VIEW}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
