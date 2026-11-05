import type { CommandView, Session } from "@switchyard/protocol";
import {
  Camera,
  ImagePlus,
  ListPlus,
  Navigation,
  Paperclip,
  SendHorizontal,
  Slash,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useHideBottomNav } from "../../app/chrome";
import { Button } from "../../components/ui/Button";
import { copyText } from "../../components/ui/Copy";
import { IconButton } from "../../components/ui/IconButton";
import { Sheet } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { TextArea } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { setDraftNow } from "../../drafts";
import { cn } from "../../lib/cn";
import { usePrefs } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi, type PromptMode } from "./api";
import { CommandViewDrawer } from "./CommandViewDrawer";
import type { SessionContext } from "./hooks";
import {
  activeArgumentHint,
  applyCompletion,
  CLIENT_COMMANDS,
  type CommandEntry,
  clientCommandProblem,
  composerBlockReason,
  filterCommands,
  type ImageAttachment,
  isBusy,
  mergeCommands,
  modelSummary,
  parseClientCommand,
  piControlsAvailable,
  readImageFile,
  SUBAGENT_READ_ONLY,
  sendModes,
} from "./model";
import { ContextMeter, EffortControl, ModelControl } from "./PiControls";
import { ResumeDialog, TreeDialog } from "./SessionCommandDialogs";
import { SessionInfoDialog } from "./SessionInfoDialog";
import { SlashCompletions, SlashPicker } from "./SlashPicker";
import { rememberInitialPrompt } from "./startingPrompts";
import { useArgumentCompletions } from "./useArgumentCompletions";
import { useSessionCommands } from "./useSessionCommands";

export interface ComposerProps {
  ctx: SessionContext;
  draft: string;
  setDraft: (t: string) => void;
  clearDraft: () => void;
  mobile: boolean;
  className?: string;
}

const AUTOMATION_WARNING = "Automation is active; take over to stop automatic continuations";

/**
 * Multiline composer. Desktop: Enter sends, Shift+Enter is a newline
 * (configurable). Mobile: Return is a newline and Send is explicit. While Pi is
 * running it offers "Steer" (only when the runtime supports it) and "Queue
 * follow-up". The draft is cleared only after the coordinator acknowledged.
 */
export function Composer({ ctx, draft, setDraft, clearDraft, mobile, className }: ComposerProps) {
  const { session, host } = ctx;
  const sendWithEnter = usePrefs((s) => s.sendWithEnter);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [busy, setBusy] = useState<PromptMode | null>(null);
  const [error, setError] = useState<{ error: unknown; mode: PromptMode } | null>(null);
  const [focused, setFocused] = useState(false);
  const [attachSheet, setAttachSheet] = useState(false);
  const [commandSheet, setCommandSheet] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [view, setView] = useState<CommandView | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [dialogKind, setDialogKind] = useState<null | "tree" | "fork" | "resume" | "info">(null);
  const navigate = useNavigate();
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
  const controls = piControlsAvailable(host, block);
  const {
    commands,
    error: cmdError,
    loading: cmdLoading,
    refresh,
  } = useSessionCommands(session.id, controls);
  const entries = controls ? mergeCommands(CLIENT_COMMANDS, commands) : [];
  const [argsDismissed, setArgsDismissed] = useState(false);
  const completions = useArgumentCompletions(session.id, draft, controls && focused && !slashOpen);
  const completing = completions.items.length > 0 && !argsDismissed;
  const argHint = controls && !slashOpen && !completing ? activeArgumentHint(draft, entries) : null;
  const applyItem = (v: string) => {
    setDraft(applyCompletion(draft, completions.prefix, v));
    textRef.current?.focus();
  };
  const shown = slashOpen ? filterCommands(entries, draft.slice(1)) : [];
  const clientCmd = controls ? parseClientCommand(text) : null;
  const commandProblem = clientCmd
    ? clientCommandProblem(clientCmd, running, !!session.nativeHandle)
    : null;
  const openSession = (id: string) => navigate(`/code/${encodeURIComponent(id)}`);
  const startNew = async (prompt: string): Promise<Session> => {
    if (!session.projectId || !session.workspaceId) {
      throw new Error("This session has no project workspace");
    }
    const s = await codeApi.createSession({
      projectId: session.projectId,
      workspace: { existingId: session.workspaceId },
      prompt,
    });
    useSyncStore.getState().upsertSessionIfMissing(s);
    if (prompt) rememberInitialPrompt(s.id, prompt);
    return s;
  };
  const afterBranch = async (r: { session: Session | null; prefill: string | null }) => {
    if (r.session) {
      useSyncStore.getState().upsertSessionIfMissing(r.session);
      if (r.prefill) setDraftNow(r.session.id, r.prefill);
      void codeApi.resume(r.session.id).catch(() => {});
      openSession(r.session.id);
      return;
    }
    const s = await startNew("");
    setDraftNow(s.id, r.prefill ?? "");
    openSession(s.id);
  };
  const runViewCommand = async (command: string) => {
    setViewBusy(true);
    try {
      const r = await codeApi.prompt(session.id, { text: command, mode: "prompt" });
      if (r?.result?.view) setView(r.result.view);
      else {
        setView(null);
        toast.success(`Ran ${command}`);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setViewBusy(false);
    }
  };
  const pickBranch = async (entryId: string) => {
    const fork = dialogKind === "fork";
    setDialogKind(null);
    try {
      await afterBranch(await codeApi.branch(session.id, entryId, fork));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const pick = (e: CommandEntry) => {
    setDraft(`/${e.name} `);
    textRef.current?.focus();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight as the draft changes
  useEffect(() => {
    setActive(0);
    setArgsDismissed(false);
  }, [draft]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the picker opens
  useEffect(() => {
    if (slashOpen || commandSheet) refresh();
  }, [slashOpen, commandSheet]);

  const send = async (mode: PromptMode) => {
    if (block || noText || busy || commandProblem) return;
    const sent = draft;
    setBusy(mode);
    setError(null);
    try {
      if (clientCmd) {
        await runClientCommand(clientCmd);
        if (textRef.current?.value === sent) clearDraft();
        setSlashDismissed(false);
        return;
      }
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
      if (res?.result?.view) setView(res.result.view);
      if (res?.automationActive) toast.info(AUTOMATION_WARNING);
      else if (mode === "followUp") toast.success("Follow-up queued");
      else if (mode === "steer") toast.success("Steering message sent");
    } catch (e) {
      setError({ error: e, mode });
    } finally {
      setBusy(null);
    }
  };

  const runClientCommand = async (cmd: NonNullable<typeof clientCmd>) => {
    switch (cmd.kind) {
      case "model-picker":
        setModelPickerOpen(true);
        return;
      case "model":
        await codeApi.setModel(session.id, cmd.provider, cmd.modelId);
        toast.success(`Model: ${cmd.provider}/${cmd.modelId}`);
        return;
      case "thinking":
        await codeApi.setThinking(session.id, cmd.level);
        toast.success(`Effort: ${cmd.level}`);
        return;
      case "compact":
        await codeApi.compact(session.id, cmd.instructions);
        toast.success("Compacting context");
        return;
      case "name":
        await codeApi.rename(session.id, cmd.title);
        toast.success("Session renamed");
        return;
      case "new":
        openSession((await startNew(cmd.prompt)).id);
        return;
      case "fork":
        setDialogKind("fork");
        return;
      case "tree":
        setDialogKind("tree");
        return;
      case "resume":
        setDialogKind("resume");
        return;
      case "clone":
        await afterBranch(await codeApi.branch(session.id, null, false));
        return;
      case "reload":
        await codeApi.reload(session.id);
        toast.success("Reloading Pi…");
        return;
      case "export": {
        const f = await codeApi.exportFile(session.id);
        const url = URL.createObjectURL(new Blob([f.content], { type: "application/x-ndjson" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = f.fileName;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      case "session":
        setDialogKind("info");
        return;
      case "copy":
        if (session.lastAssistantText) {
          await copyText(session.lastAssistantText, "Copied the last reply");
        } else toast.info("No reply to copy yet");
        return;
      default:
        return;
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
    : commandProblem
      ? commandProblem
      : running && !primaryMode
        ? "Pi is running and this runtime cannot queue messages; wait or stop the session"
        : noText && attachments.length > 0
          ? "Add a message to send with the images"
          : null;

  // Mobile: send on touchend and suppress the synthetic click. Losing focus first would bring the
  // bottom nav back and move the button from under the finger. Then blur, so the keyboard closes
  // after sending.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const tapToSend = (mode: PromptMode, enabled: boolean) =>
    mobile
      ? {
          onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
          onTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => {
            const t = e.touches[0];
            touchStart.current = t ? { x: t.screenX, y: t.screenY } : null;
          },
          onTouchEnd: (e: React.TouchEvent<HTMLButtonElement>) => {
            // Compare touch to touch: iOS reports client coordinates relative to the visual
            // viewport while the keyboard is up, so they cannot be compared with the button's rect.
            const start = touchStart.current;
            touchStart.current = null;
            const t = e.changedTouches[0];
            if (!start || !t) return;
            if (Math.hypot(t.screenX - start.x, t.screenY - start.y) > 12) return; // a scroll
            e.preventDefault();
            if (!enabled) return;
            void send(mode);
            textRef.current?.blur();
          },
        }
      : undefined;

  const pills =
    controls && session.model ? (
      <>
        <ModelControl
          session={session}
          enabled={controls}
          mobile={mobile}
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
        />
        <span className={cn("contents", running && "max-md:hidden")}>
          <EffortControl session={session} enabled={controls} mobile={mobile} />
        </span>
      </>
    ) : null;
  const queued = session.queue.steering.length + session.queue.followUp.length;

  return (
    <section
      data-testid="composer"
      aria-label="Composer"
      className={cn(
        "shrink-0 border-t border-border bg-surface px-3 pt-2 md:px-6",
        mobile ? "safe-pb-2" : "pb-2",
        className,
      )}
    >
      <div className="flex w-full min-w-0 flex-col gap-2">
        {controls && session.model && <ContextMeter session={session} enabled={controls} />}
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
          {completing && (
            <SlashCompletions
              className="absolute bottom-full left-0 z-20 mb-1 w-full rounded-lg border border-border bg-surface p-1 shadow-pop"
              id={`${hintId}-args`}
              items={completions.items}
              active={Math.min(active, completions.items.length - 1)}
              onPick={applyItem}
              onHover={setActive}
            />
          )}
          {slashOpen && controls && (
            <SlashPicker
              className="absolute bottom-full left-0 z-20 mb-1 w-full rounded-lg border border-border bg-surface p-1 shadow-pop"
              id={`${hintId}-cmds`}
              entries={shown}
              active={active}
              onPick={pick}
              onHover={setActive}
              status={
                cmdLoading && commands.length === 0
                  ? "Loading Pi's commands…"
                  : cmdError
                    ? `Pi's commands could not be loaded: ${errorMessage(cmdError)}`
                    : shown.length === 0
                      ? "No matching command; Enter sends the text to Pi"
                      : null
              }
            />
          )}
          {argHint && (
            <p
              data-testid="command-args-hint"
              className="absolute bottom-full left-0 z-10 mb-1 rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-muted"
            >
              /{argHint.name} {argHint.hint}
            </p>
          )}
          {slashOpen && !controls && (
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
            {...(slashOpen && controls
              ? {
                  role: "combobox" as const,
                  "aria-autocomplete": "list" as const,
                  "aria-expanded": true,
                  "aria-controls": `${hintId}-cmds`,
                  "aria-activedescendant": shown.length ? `${hintId}-cmds-${active}` : undefined,
                }
              : {})}
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
              if (completing) {
                const n = completions.items.length;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
                  return;
                }
                if (
                  e.key === "Tab" ||
                  (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
                ) {
                  e.preventDefault();
                  applyItem(completions.items[Math.min(active, n - 1)]!.value);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setArgsDismissed(true);
                  return;
                }
              }
              if (slashOpen && controls && shown.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = shown.length;
                  setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
                  return;
                }
                if (
                  e.key === "Tab" ||
                  (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
                ) {
                  e.preventDefault();
                  pick(shown[Math.min(active, shown.length - 1)]!);
                  return;
                }
              }
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
          {pills ? (
            <div
              data-testid="session-controls"
              className="flex min-w-0 flex-1 items-center gap-1 max-md:overflow-hidden"
            >
              {pills}
            </div>
          ) : (
            <>
              <span
                className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:inline"
                title="Profile, model and effort come from the session's Pi profile (Settings › Profiles). They apply when a session starts."
              >
                {modelSummary(session)}
              </span>
              <span className="min-w-0 flex-1 sm:hidden" />
            </>
          )}
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
                  className="shrink-0"
                  icon={<Navigation className="size-3.5" />}
                  busy={busy === "steer"}
                  disabled={
                    !!block || noText || !!commandProblem || (busy !== null && busy !== "steer")
                  }
                  onClick={() => void send("steer")}
                  {...tapToSend(
                    "steer",
                    !block && !noText && !commandProblem && (busy === null || busy === "steer"),
                  )}
                >
                  <span className="max-[379px]:sr-only">Steer</span>
                </Button>
              )}
              {modes.followUp && (
                <Button
                  size="sm"
                  variant="primary"
                  className="shrink-0"
                  icon={<ListPlus className="size-3.5" />}
                  busy={busy === "followUp"}
                  disabled={
                    !!block || noText || !!commandProblem || (busy !== null && busy !== "followUp")
                  }
                  onClick={() => void send("followUp")}
                  {...tapToSend(
                    "followUp",
                    !block && !noText && !commandProblem && (busy === null || busy === "followUp"),
                  )}
                >
                  <span className="max-[379px]:hidden">Queue follow-up</span>
                  <span className="min-[380px]:hidden">Queue</span>
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<SendHorizontal className="size-3.5" />}
              busy={busy === "prompt"}
              disabled={!!block || noText || !!commandProblem}
              onClick={() => void send("prompt")}
              {...tapToSend("prompt", !block && !noText && !commandProblem && busy === null)}
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
        {controls ? (
          <SlashPicker
            id={`${hintId}-sheet-cmds`}
            entries={entries}
            active={-1}
            status={
              cmdLoading && commands.length === 0
                ? "Loading Pi's commands…"
                : cmdError
                  ? `Pi's commands could not be loaded: ${errorMessage(cmdError)}`
                  : null
            }
            onPick={(e) => {
              setDraft(`/${e.name} `);
              setCommandSheet(false);
              requestAnimationFrame(() => textRef.current?.focus());
            }}
          />
        ) : (
          <SlashHint adapters={commandAdapters.map((a) => a.id)} />
        )}
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
      <TreeDialog
        session={session}
        mode={dialogKind === "fork" ? "fork" : "tree"}
        open={dialogKind === "tree" || dialogKind === "fork"}
        mobile={mobile}
        onClose={() => setDialogKind(null)}
        onPick={(id) => void pickBranch(id)}
      />
      <ResumeDialog
        session={session}
        open={dialogKind === "resume"}
        mobile={mobile}
        onClose={() => setDialogKind(null)}
        onOpen={(id) => {
          setDialogKind(null);
          openSession(id);
        }}
      />
      <SessionInfoDialog
        session={session}
        hostLabel={`${ctx.hostName} (${ctx.link})`}
        open={dialogKind === "info"}
        onClose={() => setDialogKind(null)}
      />
      <CommandViewDrawer
        view={view}
        open={!!view}
        busy={viewBusy}
        mobile={mobile}
        onClose={() => setView(null)}
        onRun={(c) => void runViewCommand(c)}
      />
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
