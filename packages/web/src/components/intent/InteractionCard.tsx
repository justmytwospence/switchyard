import type { Interaction, InteractionResponse, UINode } from "@switchyard/protocol";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { apiPost, errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { Button } from "../ui/Button";
import { StatusChip } from "../ui/StatusChip";
import { ErrorState, UnsupportedCapability } from "../ui/states";
import { UINodeRenderer } from "./UINodeRenderer";

export interface InteractionCardProps {
  interaction: Interaction;
  /** Read-only session or host offline: show the question without answer controls. */
  readOnlyReason?: string | null;
  className?: string;
  /** Called after the coordinator acknowledged an answer. */
  onAnswered?: (interaction: Interaction) => void;
  /** DOM id (the "Needs your answer" strip scrolls to it). */
  id?: string;
}

function hasInteractive(node: UINode): boolean {
  switch (node.t) {
    case "form":
    case "confirm":
    case "actions":
      return true;
    case "list":
      return node.items.some(hasInteractive);
    case "section":
      return node.children.some(hasInteractive);
    case "tabs":
      return node.tabs.some((t) => t.children.some(hasInteractive));
    default:
      return false;
  }
}

function byLabel(by: string): string {
  if (by === "host") return "the host";
  if (by === "pi") return "Pi";
  return "a device";
}

/**
 * A runtime interaction (extension dialog). Posts the answer with the
 * interaction revision and waits for the acknowledgement; there is no
 * optimistic resolution. A 409 shows "Already answered: <summary>".
 */
export function InteractionCard({
  interaction: fromProps,
  readOnlyReason,
  className,
  onAnswered,
  id,
}: InteractionCardProps) {
  const upsert = useSyncStore((s) => s.upsertInteraction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [alreadyAnswered, setAlreadyAnswered] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<InteractionResponse | null>(null);
  // The acknowledged interaction from the answer/409 response, until the prop catches up.
  const [acked, setAcked] = useState<Interaction | null>(null);
  const interaction =
    acked && acked.id === fromProps.id && acked.revision > fromProps.revision ? acked : fromProps;

  const pending = interaction.state === "pending";
  const unsupported =
    interaction.state === "unsupported" || interaction.source.kind === "unsupported_custom";

  const respond = async (response: InteractionResponse) => {
    setBusy(true);
    setError(null);
    setLastResponse(response);
    try {
      const res = await apiPost<{ status: string; interaction: Interaction }>(
        `/api/interactions/${encodeURIComponent(interaction.id)}/answer`,
        { revision: interaction.revision, response },
      );
      if (res?.interaction) {
        upsert(res.interaction);
        setAcked(res.interaction);
        onAnswered?.(res.interaction);
      }
    } catch (e) {
      if (isApiError(e, "already_answered")) {
        const other = (e.details as { interaction?: Interaction } | undefined)?.interaction;
        if (other) {
          upsert(other);
          setAcked(other);
        }
        setAlreadyAnswered(other?.resolution?.summary ?? "answered on another device");
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      id={id}
      aria-label={`Question: ${interaction.title}`}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-3",
        pending ? "border-warning" : "border-border",
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-start gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold break-words">{interaction.title}</h3>
        <StatusChip kind="interaction" value={interaction.state} size="sm" />
      </header>

      {alreadyAnswered && (
        <p role="status" className="rounded-md bg-surface-2 px-3 py-2 text-sm">
          Already answered: {alreadyAnswered}
        </p>
      )}

      {unsupported ? (
        <UnsupportedCapability
          capability="This dialog"
          reason={
            interaction.source.kind === "unsupported_custom"
              ? "The extension opened a terminal-only custom UI that Switchyard cannot display. Answer it in a terminal attached to this Pi session, or stop the session."
              : "No renderer in this client supports this interaction."
          }
        />
      ) : pending && !alreadyAnswered ? (
        <>
          {readOnlyReason && <p className="text-sm text-muted">{readOnlyReason}</p>}
          <UINodeRenderer
            node={interaction.presentation}
            onRespond={(r) => void respond(r)}
            busy={busy}
            disabled={!!readOnlyReason}
          />
          {!readOnlyReason && !hasInteractive(interaction.presentation) && (
            <div>
              <Button busy={busy} onClick={() => void respond({ kind: "cancel" })}>
                Dismiss
              </Button>
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-muted">
              Sending answer… waiting for the host to confirm.
            </p>
          )}
        </>
      ) : alreadyAnswered ? null : interaction.resolution ? (
        <p className="text-sm text-muted">
          {interaction.state === "resolved" ? "Answered" : "Closed"} by{" "}
          {byLabel(interaction.resolution.by)} {formatRelative(interaction.resolution.at)}:{" "}
          <span className="text-text">{interaction.resolution.summary}</span>
        </p>
      ) : (
        <p className="text-sm text-muted">
          {interaction.state === "expired"
            ? "This question expired before it was answered (Pi closed the dialog)."
            : "This question was cancelled."}
        </p>
      )}

      {error !== null && (
        <ErrorState
          compact
          title="Answer not delivered"
          error={errorMessage(error)}
          onRetry={lastResponse ? () => void respond(lastResponse) : undefined}
        />
      )}
    </article>
  );
}
