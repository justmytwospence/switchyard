import type { ContributionPlacement, Panel } from "@switchyard/protocol";
import { useContributions, useSyncStore } from "../../sync/store";
import { AdapterPanel } from "./AdapterPanel";
import { useSessionContext } from "./hooks";

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
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {panels.map((p) => (
          <span
            key={JSON.stringify([p.adapterId, p.contribution?.id])}
            title={p.title}
            className="max-w-36 min-w-0 truncate rounded border border-border px-2 py-1 text-xs"
          >
            {p.node?.t === "text" ? p.node.text : p.node?.t === "progress" ? p.node.label : p.title}
          </span>
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
