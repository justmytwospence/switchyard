import type { Interaction, InteractionResponse, UINode } from "@switchyard/protocol";
import { ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBreakpoint } from "../../app/useBreakpoint";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { apiPost, errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Sheet } from "../ui/Overlay";
import { StatusChip } from "../ui/StatusChip";
import { ErrorState } from "../ui/states";
import { TextArea } from "../ui/TextArea";
import { TextLink } from "../ui/TextLink";
import { headingSlug, Markdown } from "./Markdown";
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
  /** Stick the document header to the top of its scroller (false when the page scrolls). */
  sticky?: boolean;
  /** The page itself scrolls (no padded scroller): pin the header and bar flush. */
  flush?: boolean;
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
  sticky,
  flush,
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

  /** "Send a message to Pi": deliver the message first, then record the choice. */
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

  const bp = useBreakpoint();
  if (
    pending &&
    !alreadyAnswered &&
    !unsupported &&
    isDocumentPresentation(interaction.presentation)
  ) {
    return (
      <DocumentInteraction
        id={id}
        interaction={interaction}
        node={interaction.presentation}
        onRespond={(r) => void respond(r)}
        busy={busy}
        disabled={!!readOnlyReason}
        mobile={bp === "mobile"}
        sticky={sticky ?? true}
        flush={flush ?? false}
        className={className}
      />
    );
  }

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

function firstMarkdown(node: UINode): string | null {
  if (node.t === "markdown") return node.text;
  if (node.t === "section") {
    for (const c of node.children) {
      const m = firstMarkdown(c);
      if (m !== null) return m;
    }
  }
  return null;
}

/** A long document with trailing options (a plan awaiting approval). */
export function isDocumentPresentation(node: UINode): boolean {
  if (!splitPresentation(node)) return false;
  const md = firstMarkdown(node);
  return md !== null && (md.length >= 400 || md.split("\n").length >= 12);
}

/** The first heading of a document, its text and the markdown without it. */
export function leadingHeading(md: string): { title: string | null; rest: string } {
  const m = /^\s*#{1,6}\s+(.+?)\s*(?:\n+|$)/.exec(md);
  return m?.[1] ? { title: m[1], rest: md.slice(m[0].length) } : { title: null, rest: md };
}

/** `##` headings of a document, for the outline. */
export function documentSections(md: string): { text: string; id: string }[] {
  const out: { text: string; id: string }[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (m?.[1]) out.push({ text: m[1], id: headingSlug(m[1]) });
  }
  return out;
}

/** Id of the outline entry whose heading is the last one scrolled past the top. */
function useActiveSection(ids: string[], root: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const key = ids.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !ids.length) return;
    const els = ids
      .map((i) => root.current?.querySelector<HTMLElement>(`#${CSS.escape(i)}`))
      .filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-56px 0px -70% 0px" },
    );
    for (const e of els) io.observe(e);
    // A click on an entry near the end cannot scroll it to the top: it stays selected until the
    // reader scrolls again.
    const release = () => setPinned(null);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", release);
    return () => {
      io.disconnect();
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", release);
    };
  }, [key, root]);
  const shown = pinned ?? active;
  // Mark the heading in the text that the outline highlights.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    for (const h of r.querySelectorAll<HTMLElement>("h2[data-active]")) delete h.dataset.active;
    if (shown) {
      const el = r.querySelector<HTMLElement>(`#${CSS.escape(shown)}`);
      if (el) el.dataset.active = "true";
    }
  }, [shown, key, root]);
  return [shown, setPinned] as const;
}

/**
 * Document question (a plan awaiting approval): no card of its own. The plan's own heading titles
 * it, the question labels the answers, revisions come first. Phone: compact header, prose, a bar
 * with the answers pinned to the bottom. Desktop: a section outline beside prose at a readable
 * measure, and a wrapping bar of answers. The bar hides while the inline options are on screen.
 */
function DocumentInteraction({
  id,
  interaction,
  node,
  onRespond,
  busy,
  disabled,
  mobile,
  sticky,
  flush,
  className,
}: {
  id?: string;
  interaction: Interaction;
  node: UINode;
  onRespond: (r: InteractionResponse) => void;
  busy: boolean;
  disabled: boolean;
  mobile: boolean;
  sticky: boolean;
  flush: boolean;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLElement>(null);
  const optionsVisible = useOnScreen(optionsRef);
  const [sheet, setSheet] = useState(false);
  const split = splitPresentation(node);
  const md =
    split?.body.t === "section"
      ? (split.body.children.find((c) => c.t === "markdown") as
          | Extract<UINode, { t: "markdown" }>
          | undefined)
      : undefined;
  const { title: heading, rest } = leadingHeading(md?.text ?? "");
  const sections = documentSections(rest);
  const [active, pinSection] = useActiveSection(
    sections.map((s) => s.id),
    bodyRef,
  );
  if (split?.body.t !== "section") return null;
  const options = (split.actions as Extract<UINode, { t: "actions" }>).actions;
  const changes = split.body.children.find((c) => c.t === "section");
  const question = interaction.title;
  const title = heading ?? question;
  const answer = (actionId: string) => {
    setSheet(false);
    onRespond({ kind: "action", actionId });
  };
  const variant = (i: number, tone?: string) =>
    i === 0 || tone === "primary" ? "primary" : tone === "danger" ? "danger" : "secondary";
  const showBar = !disabled && !optionsVisible;
  const wrapBtn = "h-auto min-h-9 min-w-0 py-1.5 text-left leading-tight whitespace-normal";
  const jump = (el: HTMLElement | null) => scrollTo(el, "start");
  return (
    <article
      id={id}
      data-testid="document-interaction"
      aria-label={`Question: ${question}`}
      className={cn(
        "w-full min-w-0 self-stretch border-t border-border",

        className,
      )}
    >
      <header
        className={cn(
          "z-10 flex min-w-0 items-center gap-2 border-b border-border bg-bg px-4 py-2 md:px-6",
          sticky && (flush ? "md:sticky md:top-0" : "max-md:static md:sticky md:-top-3"),
        )}
      >
        <h3 className="min-w-0 flex-1 truncate text-[15px] leading-snug font-semibold md:text-sm">
          {title}
        </h3>
        <StatusChip
          kind="interaction"
          value={interaction.state}
          size="sm"
          className={mobile ? "[&>span]:sr-only" : undefined}
        />
        {!disabled && !optionsVisible && (
          <TextLink
            size="xs"
            className="shrink-0"
            onClick={() => scrollTo(optionsRef.current, "center")}
          >
            Jump to options ↓
          </TextLink>
        )}
      </header>
      {changes && (
        <aside className="mx-4 mt-3 rounded-md bg-warning-soft px-3 py-2 text-sm md:mx-6">
          <UINodeRenderer node={changes} />
        </aside>
      )}
      <div className="px-4 py-4 md:grid md:grid-cols-[13rem_minmax(0,1fr)] 2xl:grid-cols-[15rem_minmax(0,1fr)] md:gap-8 md:px-6">
        {sections.length > 0 && (
          <nav aria-label="Plan sections" className="hidden md:block">
            <ol className="sticky top-16 flex flex-col gap-0.5 border-l border-border text-sm">
              <li>
                <button
                  type="button"
                  className="-ml-px block w-full truncate border-l-2 border-transparent py-1 pl-3 text-left text-muted hover:text-text"
                  onClick={() => jump(startRef.current)}
                >
                  Start
                </button>
              </li>
              {sections.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={active === s.id}
                    className="-ml-px block w-full truncate border-l-2 border-transparent py-1 pl-3 text-left text-muted hover:text-text aria-[current=true]:border-accent aria-[current=true]:text-text"
                    onClick={() => {
                      pinSection(s.id);
                      jump(
                        bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(s.id)}`) ?? null,
                      );
                    }}
                  >
                    {s.text}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div ref={startRef} className="min-w-0 scroll-mt-14">
          <div
            ref={bodyRef}
            className="sy-prose-compact max-w-[80ch] min-w-0 2xl:max-w-[100ch] min-[1800px]:text-base [&_h2]:scroll-mt-14"
          >
            <Markdown text={rest} headingIds className="text-inherit" />
          </div>
        </div>
      </div>
      <section
        ref={optionsRef}
        data-testid="plan-options"
        aria-label={question}
        className="border-t border-border px-4 py-3 md:px-6"
      >
        <p className="mb-2 text-sm font-medium">{question}</p>
        {!disabled && (
          <div className="flex min-w-0 flex-col gap-2 md:flex-row md:flex-wrap">
            {options.map((o, i) => (
              <Button
                key={o.id}
                variant={variant(i, o.tone)}
                size="md"
                disabled={busy}
                className={cn(wrapBtn, "md:text-center")}
                onClick={() => answer(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}
        <TextLink
          size="xs"
          className="mt-2"
          icon={<ArrowUp aria-hidden className="size-3.5" />}
          onClick={() => jump(startRef.current)}
        >
          Back to the plan start
        </TextLink>
      </section>
      {showBar && (
        <div
          data-testid="answer-bar"
          className={cn(
            "z-10 flex min-w-0 items-center gap-2 border-t border-border bg-bg px-4 py-2 md:gap-3 md:px-6",
            sticky && !flush ? "sticky -bottom-3" : "sticky bottom-0",
          )}
        >
          {mobile ? (
            <>
              <IconButton
                label="Plan start"
                icon={<ArrowUp className="size-4" />}
                variant="secondary"
                onClick={() => jump(startRef.current)}
              />
              {options.length > 2 ? (
                <>
                  <Button
                    variant="primary"
                    disabled={busy}
                    className={cn(wrapBtn, "flex-1")}
                    onClick={() => answer(options[0]!.id)}
                  >
                    {options[0]!.label}
                  </Button>
                  <Button variant="secondary" onClick={() => setSheet(true)}>
                    More ({options.length - 1})
                  </Button>
                </>
              ) : (
                options.map((o, i) => (
                  <Button
                    key={o.id}
                    variant={variant(i, o.tone)}
                    disabled={busy}
                    className={cn(wrapBtn, "flex-1")}
                    onClick={() => answer(o.id)}
                  >
                    {o.label}
                  </Button>
                ))
              )}
            </>
          ) : (
            <>
              <span className="shrink-0 text-sm font-medium">{question}</span>
              <div className="grid min-w-0 flex-1 grid-cols-3 gap-2 min-[2200px]:grid-cols-6">
                {options.map((o, i) => (
                  <Button
                    key={o.id}
                    variant={variant(i, o.tone)}
                    disabled={busy}
                    className="w-full"
                    onClick={() => answer(o.id)}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
              <IconButton
                label="Plan start"
                icon={<ArrowUp className="size-4" />}
                variant="secondary"
                size="sm"
                onClick={() => jump(startRef.current)}
              />
            </>
          )}
        </div>
      )}
      <Sheet open={sheet} onClose={() => setSheet(false)} title={question}>
        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <Button
              key={o.id}
              block
              variant={variant(i, o.tone)}
              disabled={busy}
              className={wrapBtn}
              onClick={() => answer(o.id)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </Sheet>
    </article>
  );
}
