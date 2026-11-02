import {
  Camera,
  Hand,
  ImagePlus,
  ListPlus,
  Navigation,
  Paperclip,
  Play,
  SendHorizontal,
  Slash,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useHideBottomNav } from "../../app/chrome";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Sheet } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { TextArea } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { usePrefs } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { codeApi, type PromptMode } from "./api";
import type { SessionContext } from "./hooks";
import {
  composerBlockReason,
  type ImageAttachment,
  isBusy,
  readImageFile,
  SUBAGENT_READ_ONLY,
  sendModes,
} from "./model";

export interface ComposerProps {
  ctx: SessionContext;
  draft: string;
  setDraft: (t: string) => void;
  clearDraft: () => void;
  mobile: boolean;
  onTakeover?: () => void;
  takeoverBusy?: boolean;
  onResume?: () => void;
  resumeBusy?: boolean;
  className?: string;
}

const AUTOMATION_WARNING = "Automation is active; take over to stop automatic continuations";

/**
 * Multiline composer. Desktop: Enter sends, Shift+Enter is a newline
 * (configurable). Mobile: Return is a newline and Send is explicit. While Pi is
 * running it offers "Steer" (only when the runtime supports it) and "Queue
 * follow-up". The draft is cleared only after the coordinator acknowledged.
 */
export function Composer({
  ctx,
  draft,
  setDraft,
  clearDraft,
  mobile,
  onTakeover,
  takeoverBusy,
  onResume,
  resumeBusy,
  className,
}: ComposerProps) {
  const { session, host } = ctx;
  const sendWithEnter = usePrefs((s) => s.sendWithEnter);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [busy, setBusy] = useState<PromptMode | null>(null);
  const [error, setError] = useState<{ error: unknown; mode: PromptMode } | null>(null);
  const [focused, setFocused] = useState(false);
  const [attachSheet, setAttachSheet] = useState(false);
  const [commandSheet, setCommandSheet] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useHideBottomNav(mobile && focused);

  // Attachments and errors belong to one session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the session changes
  useEffect(() => {
    setAttachments([]);
    setError(null);
  }, [session.id]);

  const block = composerBlockReason({ session, hostLink: ctx.link, hostName: ctx.hostName });
  const modes = sendModes(session, host?.capabilities);
  const running = isBusy(session);
  const text = draft.trim();
  const noText = !text;
  const commandAdapters = ctx.adapters.filter(
    (a) => a.status === "active" && a.capabilities.includes("commands"),
  );
  const slashOpen = !mobile && !slashDismissed && /^\/\S*$/.test(draft) && focused;

  const send = async (mode: PromptMode) => {
    if (block || noText || busy) return;
    const sent = draft;
    setBusy(mode);
    setError(null);
    try {
      const res = await codeApi.prompt(session.id, {
        text,
        mode,
        images: attachments.map((a) => ({ mimeType: a.mimeType, data: a.data })),
        clientMessageId: `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      });
      // Keep anything typed while sending.
      if (textRef.current?.value === sent) clearDraft();
      setAttachments([]);
      setSlashDismissed(false);
      if (res?.automationActive) toast.info(AUTOMATION_WARNING);
      else if (mode === "followUp") toast.success("Follow-up queued");
      else if (mode === "steer") toast.success("Steering message sent");
    } catch (e) {
      setError({ error: e, mode });
    } finally {
      setBusy(null);
    }
  };

  const primaryMode: PromptMode | null = modes.prompt
    ? "prompt"
    : modes.followUp
      ? "followUp"
      : modes.steer
        ? "steer"
        : null;

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const a = await readImageFile(f);
        setAttachments((prev) => [...prev, a]);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }
  };

  const sendReason = block
    ? block.reason
    : running && !primaryMode
      ? "Pi is running and this runtime cannot queue messages; wait or stop the session"
      : noText && attachments.length > 0
        ? "Add a message to send with the images"
        : null;

  // Mobile: tapping Send must not blur the draft first. The blur would bring back the bottom
  // nav (hidden while composing) and shift the composer under the finger, losing the tap.
  const keepFocus = mobile
    ? { onPointerDown: (e: React.PointerEvent) => e.preventDefault() }
    : undefined;

  const profile = session.profileSnapshot;
  const profileText = [
    profile.name,
    profile.provider && profile.model
      ? `${profile.provider}/${profile.model}`
      : (profile.model ?? null),
    profile.thinking ? `effort ${profile.thinking}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const queued = session.queue.steering.length + session.queue.followUp.length;

  return (
    <section
      data-testid="composer"
      aria-label="Composer"
      className={cn("shrink-0 border-t border-border bg-surface px-3 pt-2 pb-2", className)}
    >
      <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-2">
        {ctx.control === "automation" && !block && (
          <div
            role="note"
            className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-1.5 text-sm"
          >
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">{AUTOMATION_WARNING}</span>
            {onTakeover && (
              <Button
                size="sm"
                icon={<Hand className="size-3.5" />}
                busy={takeoverBusy}
                onClick={onTakeover}
              >
                Take over
              </Button>
            )}
          </div>
        )}
        {ctx.control === "human" && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Hand aria-hidden className="size-3.5" />
            You have control. Automatic continuations are paused.
          </p>
        )}
        {block && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-sm"
          >
            <span className="min-w-0 flex-1 font-medium">{block.reason}</span>
            {block.action === "resume" && onResume && (
              <Button
                size="sm"
                variant="primary"
                icon={<Play className="size-3.5" />}
                busy={resumeBusy}
                onClick={onResume}
              >
                Resume
              </Button>
            )}
          </div>
        )}
        {queued > 0 && (
          <p className="text-xs text-muted">
            {session.queue.steering.length > 0 &&
              `${session.queue.steering.length} steering message${session.queue.steering.length === 1 ? "" : "s"} pending. `}
            {session.queue.followUp.length > 0 &&
              `${session.queue.followUp.length} follow-up${session.queue.followUp.length === 1 ? "" : "s"} queued.`}
          </p>
        )}

        {attachments.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <li
                key={a.id}
                className="relative flex items-center gap-2 rounded-md border border-border bg-surface-2 py-1 pr-1 pl-1"
              >
                <img
                  src={`data:${a.mimeType};base64,${a.data}`}
                  alt=""
                  className="size-9 rounded object-cover"
                />
                <span className="max-w-32 truncate text-xs">{a.name}</span>
                <IconButton
                  size="sm"
                  label={`Remove ${a.name}`}
                  icon={<X className="size-3.5" />}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="relative min-w-0">
          {slashOpen && (
            <SlashHint
              className="absolute bottom-full left-0 z-20 mb-1 w-full rounded-lg border border-border bg-surface p-3 shadow-pop"
              adapters={commandAdapters.map((a) => a.id)}
              onClose={() => setSlashDismissed(true)}
            />
          )}
          <label htmlFor={`${hintId}-input`} className="sr-only">
            Message to Pi
          </label>
          <TextArea
            id={`${hintId}-input`}
            ref={textRef}
            value={draft}
            minRows={mobile ? 1 : 2}
            maxHeight="33vh"
            disabled={session.readOnly}
            aria-describedby={sendReason ? `${hintId}-reason` : undefined}
            placeholder={
              session.readOnly
                ? SUBAGENT_READ_ONLY
                : running
                  ? "Steer Pi or queue a follow-up…"
                  : "Message Pi… ( / for commands)"
            }
            onChange={(e) => {
              setDraft(e.target.value);
              if (!e.target.value.startsWith("/")) setSlashDismissed(false);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            enterKeyHint={mobile ? "enter" : "send"}
            onKeyDown={(e) => {
              if (e.key === "Escape" && slashOpen) {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
              if (e.key !== "Enter" || e.nativeEvent.isComposing || mobile) return;
              const wantsSend = sendWithEnter ? !e.shiftKey : e.metaKey || e.ctrlKey;
              if (!wantsSend) return;
              e.preventDefault();
              if (primaryMode) void send(primaryMode);
            }}
          />
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
              setAttachSheet(false);
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
              setAttachSheet(false);
            }}
          />
          <IconButton
            label="Attach images"
            icon={<Paperclip className="size-4" />}
            disabled={session.readOnly}
            onClick={() => (mobile ? setAttachSheet(true) : fileRef.current?.click())}
          />
          <IconButton
            label="Commands"
            icon={<Slash className="size-4" />}
            disabled={session.readOnly}
            onClick={() => {
              if (mobile) {
                setCommandSheet(true);
                return;
              }
              if (!draft.startsWith("/")) setDraft(`/${draft}`);
              setSlashDismissed(false);
              textRef.current?.focus();
            }}
          />
          <span
            className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:inline"
            title="Profile, model and effort come from the session's Pi profile (Settings › Profiles). They apply when a session starts."
          >
            {profileText}
          </span>
          <span className="min-w-0 flex-1 sm:hidden" />
          {!mobile && !running && (
            <span className="hidden text-xs text-subtle lg:inline">
              {sendWithEnter ? "Enter to send · Shift+Enter for newline" : "Ctrl+Enter to send"}
            </span>
          )}
          {running ? (
            <>
              {modes.steer && (
                <Button
                  size="sm"
                  icon={<Navigation className="size-3.5" />}
                  busy={busy === "steer"}
                  disabled={!!block || noText || (busy !== null && busy !== "steer")}
                  onClick={() => void send("steer")}
                  {...keepFocus}
                >
                  Steer
                </Button>
              )}
              {modes.followUp && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<ListPlus className="size-3.5" />}
                  busy={busy === "followUp"}
                  disabled={!!block || noText || (busy !== null && busy !== "followUp")}
                  onClick={() => void send("followUp")}
                  {...keepFocus}
                >
                  Queue follow-up
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<SendHorizontal className="size-3.5" />}
              busy={busy === "prompt"}
              disabled={!!block || noText}
              onClick={() => void send("prompt")}
              {...keepFocus}
            >
              Send
            </Button>
          )}
        </div>
        {running && !modes.steer && host?.capabilities && (
          <p className="text-xs text-muted">
            Immediate steering is not supported by this runtime; messages are queued as follow-ups.
          </p>
        )}
        {sendReason && !block && (
          <p id={`${hintId}-reason`} className="text-xs text-muted">
            {sendReason}
          </p>
        )}
        {block && (
          <p id={`${hintId}-reason`} className="sr-only">
            Sending is unavailable: {block.reason}
          </p>
        )}
        {error && (
          <ErrorState
            compact
            title="Message not sent. Your draft is kept."
            error={errorMessage(error.error)}
            onRetry={() => void send(error.mode)}
          />
        )}
      </div>

      <Sheet open={attachSheet} onClose={() => setAttachSheet(false)} title="Attach images">
        <div className="flex flex-col gap-2">
          <Button
            block
            icon={<ImagePlus className="size-4" />}
            onClick={() => fileRef.current?.click()}
          >
            Choose photos
          </Button>
          <Button
            block
            icon={<Camera className="size-4" />}
            onClick={() => cameraRef.current?.click()}
          >
            Take photo
          </Button>
          <p className="text-xs text-muted">Images up to 10 MB are sent with your next message.</p>
        </div>
      </Sheet>
      <Sheet open={commandSheet} onClose={() => setCommandSheet(false)} title="Commands">
        <SlashHint adapters={commandAdapters.map((a) => a.id)} />
        <div className="mt-3">
          <Button
            block
            variant="primary"
            onClick={() => {
              if (!draft.startsWith("/")) setDraft(`/${draft}`);
              setCommandSheet(false);
              requestAnimationFrame(() => textRef.current?.focus());
            }}
          >
            Start a command
          </Button>
        </div>
      </Sheet>
    </section>
  );
}

function SlashHint({
  adapters,
  onClose,
  className,
}: {
  adapters: string[];
  onClose?: () => void;
  className?: string;
}) {
  return (
    <div role="note" aria-label="Slash commands" className={className}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm">
          Text starting with <code className="font-mono">/</code> is sent to Pi as a command
          (extension commands and prompt templates). Switchyard does not list Pi&apos;s commands;
          type the command name.
        </p>
        {onClose && (
          <IconButton
            size="sm"
            label="Close command hint"
            icon={<X className="size-3.5" />}
            onClick={onClose}
          />
        )}
      </div>
      {adapters.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Extensions with commands on this host: {adapters.join(", ")}
        </p>
      )}
    </div>
  );
}
