import type { Interaction, InteractionResponse, UINode } from "@switchyard/protocol";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { apiPost, errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { Button } from "../ui/Button";
import { StatusChip } from "../ui/StatusChip";
import { ErrorState } from "../ui/states";
import { TextArea } from "../ui/TextArea";
import { UINodeRenderer } from "./UINodeRenderer";
import { isUnsupported, messageMode, unsupportedView } from "./unsupported";

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
  const unsupported = isUnsupported(interaction);
  const sessionRuntime = useSyncStore((s) => s.sessions[interaction.sessionId]?.runtime);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");

  const respond = async (response: InteractionResponse): Promise<boolean> => {
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
      return true;
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
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** "Send a message to the agent": deliver the message first, then record the choice. */
  const sendMessage = async () => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(interaction.sessionId)}/prompt`, {
        text,
        mode: messageMode(sessionRuntime),
      });
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (await respond({ kind: "action", actionId: "message" })) {
      setComposing(false);
      setMessage("");
    }
  };

  return (
    <article
      id={id}
      aria-label={`Question: ${interaction.title}`}
      className={cn(
        "flex min-w-0 flex-col gap-3 border-l-2 py-1 pl-3",
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
        <UnsupportedBody
          interaction={interaction}
          readOnlyReason={readOnlyReason ?? null}
          busy={busy}
          answered={alreadyAnswered !== null}
          composing={composing}
          message={message}
          setMessage={setMessage}
          onAction={(actionId) => {
            if (actionId === "message") setComposing(true);
            else void respond({ kind: "action", actionId });
          }}
          onSend={() => void sendMessage()}
          onCancelMessage={() => setComposing(false)}
        />
      ) : pending && !alreadyAnswered ? (
        <>
          {readOnlyReason && <p className="text-sm text-muted">{readOnlyReason}</p>}
          <Presentation
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

/** A terminal-only dialog: what happened, and the alternatives the host offers until one is chosen. */
function UnsupportedBody({
  interaction,
  readOnlyReason,
  busy,
  answered,
  composing,
  message,
  setMessage,
  onAction,
  onSend,
  onCancelMessage,
}: {
  interaction: Interaction;
  readOnlyReason: string | null;
  busy: boolean;
  answered: boolean;
  composing: boolean;
  message: string;
  setMessage: (t: string) => void;
  onAction: (actionId: "abort" | "message") => void;
  onSend: () => void;
  onCancelMessage: () => void;
}) {
  const view = unsupportedView(interaction);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted">{view.copy}</p>
      {interaction.resolution ? (
        <p className="text-sm text-muted">
          Chosen by {byLabel(interaction.resolution.by)} {formatRelative(interaction.resolution.at)}
          : <span className="text-text">{interaction.resolution.summary}</span>
        </p>
      ) : !view.answerable || answered ? null : readOnlyReason ? (
        <p className="text-sm text-muted">{readOnlyReason}</p>
      ) : composing ? (
        <div className="flex min-w-0 flex-col gap-2">
          <TextArea
            aria-label="Message to the agent"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Tell the agent what to do instead"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} disabled={!message.trim()} onClick={onSend}>
              Send message
            </Button>
            <Button disabled={busy} onClick={onCancelMessage}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((a) => (
            <Button
              key={a.id}
              variant={a.tone}
              busy={busy && a.id === "abort"}
              disabled={busy}
              onClick={() => onAction(a.id)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A content section that ends in a row of actions (a plan with its options), if `node` is one. */
export function splitPresentation(node: UINode): { body: UINode; actions: UINode } | null {
  if (node.t !== "section" || node.children.length < 2) return null;
  const last = node.children[node.children.length - 1];
  if (last?.t !== "actions") return null;
  const rest = node.children.slice(0, -1);
  if (rest.some(hasInteractive)) return null;
  return { body: { ...node, children: rest }, actions: last };
}

function scrollTo(el: HTMLElement | null, block: "start" | "center") {
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block });
}

/** True while `el` is (at least partly) on screen; assumed visible without IntersectionObserver. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

/**
 * Long content followed by options (a plan and its answers). The content flows in the page, with
 * no scroll box of its own. The options follow it as a row (a stack on a phone). While the options
 * are off screen a pill sticks to the bottom of the view and jumps to them; at the options, a
 * button jumps back to the start of the content.
 */
function Presentation({
  node,
  onRespond,
  busy,
  disabled,
}: {
  node: UINode;
  onRespond: (r: InteractionResponse) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionsVisible = useOnScreen(actionsRef);
  const split = splitPresentation(node);
  if (!split) {
    return <UINodeRenderer node={node} onRespond={onRespond} busy={busy} disabled={disabled} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div ref={bodyRef} className="scroll-mt-16 min-w-0">
        <UINodeRenderer node={split.body} />
      </div>
      {!actionsVisible && (
        <div className="pointer-events-none sticky bottom-3 z-10 -mb-4 flex h-0 justify-end">
          <Button
            data-testid="jump-to-options"
            size="sm"
            variant="primary"
            className="pointer-events-auto absolute bottom-0 shadow-pop"
            icon={<ArrowDown className="size-4" />}
            onClick={() => scrollTo(actionsRef.current, "center")}
          >
            Jump to options
          </Button>
        </div>
      )}
      <div
        ref={actionsRef}
        data-testid="plan-options"
        className="flex min-w-0 scroll-mb-4 flex-col gap-2 border-t border-border pt-3"
      >
        <UINodeRenderer
          node={split.actions}
          onRespond={onRespond}
          busy={busy}
          disabled={disabled}
        />
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          icon={<ArrowUp className="size-4" />}
          onClick={() => scrollTo(bodyRef.current, "start")}
        >
          Back to the start
        </Button>
      </div>
    </div>
  );
}
