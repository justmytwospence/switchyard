import { ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { InteractionCard, isDocumentPresentation } from "../../components/intent/InteractionCard";
import { IconButton } from "../../components/ui/IconButton";
import { cn } from "../../lib/cn";
import { usePendingInteractions } from "../../sync/store";
import { interactionDomId } from "./model";

/**
 * The session's pending questions, approvals and plan answers, docked above the composer: one at
 * a time, with a pager when several wait. The transcript shows only a plan's text and, once
 * answered, one line where the question was asked.
 */
export function RequestDock({
  sessionId,
  readOnlyReason,
  focusInteractionId,
  collapsed,
}: {
  sessionId: string;
  /** Answer controls hidden with this reason (read-only view, host offline). */
  readOnlyReason: string | null;
  /** `?interaction=<id>`: show that question first. */
  focusInteractionId: string | null;
  /** Show only the title (the phone composer has focus). */
  collapsed: boolean;
}) {
  const pending = usePendingInteractions(sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply the deep link when it or the list changes
  useEffect(() => {
    if (focusInteractionId && pending.some((i) => i.id === focusInteractionId)) {
      setSelected(focusInteractionId);
    }
  }, [focusInteractionId, pending.length]);
  if (pending.length === 0) return null;
  const index = Math.max(
    0,
    pending.findIndex((i) => i.id === selected),
  );
  const current = pending[index]!;
  return (
    <section
      data-testid="request-dock"
      aria-label="Needs input"
      className="flex min-w-0 flex-col rounded-lg border border-border-strong bg-bg"
    >
      <header className="flex min-w-0 items-center gap-2 px-3 py-1.5">
        <MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">
          {collapsed ? current.title : "Needs input"}
        </span>
        {pending.length > 1 && (
          <>
            <span className="shrink-0 text-xs text-muted tabular-nums">
              {index + 1} of {pending.length}
            </span>
            <IconButton
              size="sm"
              label="Previous question"
              icon={<ChevronLeft className="size-4" />}
              disabled={index === 0}
              onClick={() => setSelected(pending[index - 1]!.id)}
            />
            <IconButton
              size="sm"
              label="Next question"
              icon={<ChevronRight className="size-4" />}
              disabled={index === pending.length - 1}
              onClick={() => setSelected(pending[index + 1]!.id)}
            />
          </>
        )}
      </header>
      {/* Every card stays mounted, so a half-filled form survives paging and folding. */}
      <div
        className={cn(
          "max-h-[45dvh] min-w-0 overflow-y-auto overscroll-contain px-3 pb-3",
          collapsed && "hidden",
        )}
      >
        {pending.map((i) => {
          const doc = isDocumentPresentation(i.presentation);
          return (
            <div
              key={i.id}
              hidden={i.id !== current.id}
              data-testid="interaction-card"
              data-interaction-id={i.id}
              data-state={i.state}
              // A plan's text in the transcript carries the id; any other question lives only here.
              id={doc ? undefined : interactionDomId(i.id)}
            >
              <InteractionCard
                mode="dock"
                interaction={i}
                readOnlyReason={readOnlyReason}
                planAnchorId={doc ? interactionDomId(i.id) : undefined}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
