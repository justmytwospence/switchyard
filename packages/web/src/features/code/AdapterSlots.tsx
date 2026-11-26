import { type ContributionPlacement, type Panel, trackerText } from "@switchyard/protocol";
import { useState } from "react";
import { Popover } from "../../components/ui/Popover";
import { Spinner } from "../../components/ui/Spinner";
import { cn } from "../../lib/cn";
import { useContributions, useSyncStore } from "../../sync/store";
import { AdapterPanel } from "./AdapterPanel";
import { type SessionContext, useSessionContext } from "./hooks";

export function useAdapterSlot(
  sessionId: string | null | undefined,
  placement: ContributionPlacement,
): Panel[] {
  return useContributions(sessionId).filter((p) => p.contribution?.placement === placement);
}

/** Navigator/sidebar and composer contributions only render for the selected session. */
export function AdapterSlot({
  sessionId,
  placement,
}: {
  sessionId: string | null | undefined;
  placement: "sidebar.header" | "sidebar.footer" | "composer.pill";
}) {
  const panels = useAdapterSlot(sessionId, placement);
  const session = useSyncStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const ctx = useSessionContext(session);
  if (!ctx || !panels.length) return null;
  if (placement === "composer.pill")
    return (
      <section
        aria-label="Adapter pills"
        className="flex min-w-0 items-center gap-1.5 overflow-x-auto"
      >
        {panels.map((p) => (
          <AdapterPill
            key={JSON.stringify([p.adapterId, p.contribution?.id])}
            ctx={ctx}
            panel={p}
          />
        ))}
      </section>
    );
  return (
    <section
      aria-label={placement === "sidebar.header" ? "Adapter header" : "Adapter footer"}
      className="flex max-h-48 min-w-0 shrink-0 flex-col gap-2 overflow-y-auto border-t border-border px-2 py-2"
    >
      {panels.map((p) => (
        <AdapterPanel key={JSON.stringify([p.adapterId, p.contribution?.id])} ctx={ctx} panel={p} />
      ))}
    </section>
  );
}

const TRACKER_DOT = {
  idle: "bg-subtle",
  ok: "bg-success",
  error: "bg-danger",
  attention: "bg-warning",
} as const;

/** `composer.tracker` contributions: live summaries above the input, each opening its detail. */
export function TrackerSlot({ sessionId }: { sessionId: string }) {
  const panels = useAdapterSlot(sessionId, "composer.tracker");
  const session = useSyncStore((s) => s.sessions[sessionId]);
  const ctx = useSessionContext(session);
  if (!ctx || !panels.length) return null;
  return (
    <section aria-label="Trackers" className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
      {panels.map((p) => (
        <TrackerPill key={JSON.stringify([p.adapterId, p.contribution?.id])} ctx={ctx} panel={p} />
      ))}
    </section>
  );
}

function TrackerPill({ ctx, panel }: { ctx: SessionContext; panel: Panel }) {
  const [open, setOpen] = useState(false);
  const tracker = panel.contribution?.tracker;
  const status = tracker?.status;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      label={panel.title}
      fitViewport
      trigger={(p) => (
        <button
          type="button"
          {...p}
          data-testid="tracker"
          data-status={status}
          title={trackerText(panel.title, tracker)}
          className="relative inline-flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs text-muted hover:bg-surface-2 before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']"
        >
          {status === "running" ? (
            <Spinner className="size-3 text-info" />
          ) : status ? (
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", TRACKER_DOT[status])}
            />
          ) : null}
          <span className="shrink-0 text-text">{panel.title}</span>
          {tracker?.count && <span className="shrink-0 tabular-nums">{tracker.count}</span>}
          {tracker?.step && <span className="min-w-0 truncate">· {tracker.step}</span>}
          {status && status !== "running" && <span className="sr-only">({status})</span>}
        </button>
      )}
    >
      <AdapterPanel ctx={ctx} panel={panel} />
    </Popover>
  );
}

/** One adapter pill in the composer's tracker row: its short text, and its whole panel on demand. */
function AdapterPill({ ctx, panel }: { ctx: SessionContext; panel: Panel }) {
  const [open, setOpen] = useState(false);
  const text =
    panel.node?.t === "text"
      ? panel.node.text
      : panel.node?.t === "progress"
        ? panel.node.label
        : panel.title;
  return (
    // Fixed positioning: the row scrolls sideways and would clip an anchored panel.
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      label={panel.title}
      fitViewport
      trigger={(p) => (
        <button
          type="button"
          {...p}
          title={panel.title}
          className="relative inline-flex h-6 max-w-44 min-w-0 shrink-0 items-center rounded-full border border-border px-2 text-xs text-muted hover:bg-surface-2 before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']"
        >
          <span className="min-w-0 truncate">{text}</span>
        </button>
      )}
    >
      <AdapterPanel ctx={ctx} panel={panel} />
    </Popover>
  );
}
