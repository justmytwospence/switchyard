import type { Interaction, ToolItemData, TranscriptItem } from "@switchyard/protocol";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileCode,
  Info,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBreakpoint } from "../../app/useBreakpoint";
import { CodeBlock } from "../../components/intent/CodeBlock";
import { DiffView } from "../../components/intent/DiffView";
import {
  byLabel,
  InteractionCard,
  isDocumentPresentation,
} from "../../components/intent/InteractionCard";
import { Markdown } from "../../components/intent/Markdown";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { isUnsupported } from "../../components/intent/unsupported";
import { Sheet } from "../../components/ui/Overlay";
import { Spinner } from "../../components/ui/Spinner";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatDuration, formatRelative, formatTime } from "../../lib/time";
import { LONG_PRESS_CLASS, useLongPress } from "../../lib/useLongPress";
import { useSmoothText } from "../../lib/useSmoothText";
import { errorMessage } from "../../sync/api";
import type { StreamBuffer } from "../../sync/store";
import { useSyncStore } from "../../sync/store";
import { isAdapterViewStale, STALE_ADAPTER_VIEW } from "./AdapterPanel";
import { codeApi } from "./api";
import { useCodeContext } from "./context";
import { useNow } from "./hooks";
import { UserMessageMenu } from "./MessageActions";
import {
  entrySpacing,
  formatWorkSummary,
  interactionDomId,
  outputPreview,
  type TimelineEntry,
  type WorkSummary,
} from "./model";
import { initialPromptFor } from "./startingPrompts";
import { type ToolView, toolLabel, toolViewOf } from "./toolView";

export interface TimelineRowProps {
  entry: TimelineEntry;
  sessionId: string;
  /** Answer controls are hidden with this explanation (read-only view, host offline). */
  interactionReadOnly: string | null;
  highlightInteractionId: string | null;
}

/**
 * A turn's tool calls, thinking and interim text folded into one line that says what was done.
 * `live` is a turn still running (the Summary level): the line counts up from `startAt`.
 */
export function WorkRow({
  entries,
  summary,
  live,
  startAt,
  ...rest
}: Omit<TimelineRowProps, "entry"> & {
  entries: TimelineEntry[];
  summary: WorkSummary;
  live: boolean;
  startAt: string | null;
}) {
  const now = useNow(live);
  const started = startAt ? Date.parse(startAt) : Number.NaN;
  const text = live
    ? formatWorkSummary(
        { ...summary, durationMs: Number.isNaN(started) ? null : Math.max(0, now - started) },
        true,
      )
    : formatWorkSummary(summary);
  return (
    <details data-testid="work-row" data-live={live ? "" : undefined} className="group min-w-0">
      <summary className="tap flex cursor-pointer list-none items-center gap-1.5 px-1 text-sm text-muted">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90"
        />
        {live && <Spinner className="size-3.5" />}
        <span className="min-w-0 tabular-nums">{text}</span>
      </summary>
      <div className="mt-1.5 ml-2.5 flex min-w-0 flex-col border-l border-border pl-2">
        {entries.map((e, i) => {
          const spacing = entrySpacing(entries[i - 1] ?? null, e);
          return (
            <div
              key={e.key}
              className={cn(
                "min-w-0",
                spacing === "tight" ? "mt-0.5" : spacing !== "none" && "mt-2",
              )}
            >
              <TimelineRow entry={e} quiet {...rest} />
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Ends the transcript while Pi works and nothing else on screen says so. */
export function WorkingRow({ since }: { since: string | null }) {
  const now = useNow(true);
  const started = since ? Date.parse(since) : Number.NaN;
  const elapsed = Number.isNaN(started) ? "" : formatDuration(Math.max(0, now - started));
  return (
    <div
      role="status"
      data-testid="working-row"
      className="flex items-center gap-1.5 px-1 text-sm text-muted"
    >
      <Spinner className="size-3.5" />
      Working…
      <span aria-hidden className="tabular-nums">
        {elapsed}
      </span>
    </div>
  );
}

/** One transcript entry. `quiet` dims interim text inside a folded turn. */
export function TimelineRow(props: TimelineRowProps & { quiet?: boolean }) {
  const { entry } = props;
  if (entry.type === "stream") return <StreamEntry stream={entry.stream} />;
  if (entry.type === "interaction") {
    return (
      <InteractionEntry
        interaction={entry.interaction}
        readOnly={props.interactionReadOnly}
        highlight={props.highlightInteractionId === entry.interaction.id}
      />
    );
  }
  const { item, stream } = entry;
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} sessionId={props.sessionId} />;
    case "assistant":
      return (
        <AssistantMessage
          text={item.data.text + (stream?.text ?? "")}
          thinking={stream?.thinking ?? ""}
          streaming={!!stream || item.data.streaming === true}
          quiet={props.quiet}
        />
      );
    case "thinking":
      return <ThinkingItem text={item.data.text + (stream?.thinking ?? "")} live={!!stream} />;
    case "tool":
      return <ToolRow data={item.data} stream={stream} sessionId={props.sessionId} />;
    case "notice":
      return item.data.card && item.data.adapterId ? (
        <NoticeCard
          data={item.data}
          sessionId={props.sessionId}
          readOnly={props.interactionReadOnly}
        />
      ) : (
        <NoticeItem level={item.data.level} text={item.data.text} repeat={entry.repeat ?? 1} />
      );
    case "system":
      // A suggested next message is offered in the composer, not here.
      return item.data.suggestion === true ? null : <SystemItem text={item.data.text} />;
    case "subagent":
      return <SubagentRow data={item.data} />;
    case "interaction":
      return (
        <InteractionRef
          interactionId={item.data.interactionId}
          readOnly={props.interactionReadOnly}
          highlight={props.highlightInteractionId === item.data.interactionId}
        />
      );
  }
}

/** A message longer than this folds to eight lines behind "Show full message". */
const LONG_MESSAGE_LINES = 12;
const LONG_MESSAGE_CHARS = 1200;

function UserMessage({
  item,
  sessionId,
}: {
  item: Extract<TranscriptItem, { kind: "user" }>;
  sessionId: string;
}) {
  const [full, setFull] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = useBreakpoint() === "mobile";
  const press = useLongPress(() => setMenuOpen(true), { enabled: phone });
  const text = item.data.text;
  const long = text.length > LONG_MESSAGE_CHARS || text.split("\n").length > LONG_MESSAGE_LINES;
  return (
    <article
      aria-label={`You, ${formatTime(item.at)}`}
      className="group/msg flex min-w-0 flex-col items-end"
    >
      <div
        {...(phone ? press : {})}
        className={cn(
          "max-w-[85%] min-w-0 rounded-2xl border border-border bg-surface-2 px-3.5 py-2",
          phone && LONG_PRESS_CLASS,
        )}
      >
        <p
          className={cn("text-sm break-words whitespace-pre-wrap", long && !full && "line-clamp-8")}
        >
          {text}
        </p>
        {long && (
          <TextLink size="xs" className="mt-1" onClick={() => setFull((v) => !v)}>
            {full ? "Show less" : "Show full message"}
          </TextLink>
        )}
        {item.data.images ? (
          <p className="mt-1 text-xs text-muted">
            {item.data.images} image{item.data.images === 1 ? "" : "s"} attached
          </p>
        ) : null}
      </div>
      {/* Opacity only, so showing the row never changes the height of the transcript. */}
      <div className="mt-0.5 flex items-center gap-1 text-xs text-subtle opacity-0 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100">
        <span>{formatTime(item.at)}</span>
        <UserMessageMenu
          item={item}
          sessionId={sessionId}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        />
      </div>
    </article>
  );
}

function AssistantMessage({
  text,
  thinking,
  streaming,
  quiet,
}: {
  text: string;
  thinking: string;
  streaming: boolean;
  /** Interim text inside a folded turn: smaller and dim. */
  quiet?: boolean;
}) {
  const shownText = useSmoothText(text, streaming);
  const shownThinking = useSmoothText(thinking, streaming);
  return (
    <div data-assistant-reply={streaming ? "live" : "done"} className="min-w-0 px-1">
      <span className="sr-only select-none">Pi: </span>
      {thinking && <ThinkingItem text={shownThinking} live />}
      {text ? (
        <Markdown text={shownText} className={quiet ? "text-[13px] text-muted" : undefined} />
      ) : (
        !thinking &&
        (streaming ? (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Spinner className="size-3.5" />
            Writing…
          </p>
        ) : (
          <p className="text-sm text-muted">…</p>
        ))
      )}
    </div>
  );
}

function ThinkingItem({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="group min-w-0">
      <summary className="tap flex cursor-pointer list-none items-center gap-1.5 px-1 text-sm text-muted">
        {live ? (
          <Spinner className="size-3.5" />
        ) : (
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90"
          />
        )}
        {live ? "Thinking…" : "Thought"}
      </summary>
      <p className="mt-1 ml-2.5 border-l border-border pl-3 text-xs break-words whitespace-pre-wrap text-muted">
        {text}
      </p>
    </details>
  );
}

const TOOL_STATUS: Record<ToolItemData["status"], { label: string }> = {
  running: { label: "Running" },
  ok: { label: "Done" },
  error: { label: "Failed" },
};

/**
 * A tool call as one line: what it did and to what. Opening it shows the detail for its kind,
 * in place on desktop and in a sheet on a phone. An adapter's card shows under the line, open,
 * on every device.
 */
export function ToolRow({
  data,
  stream,
  sessionId,
}: {
  data: ToolItemData;
  stream: StreamBuffer | null;
  sessionId: string;
}) {
  const { mobile, openFile } = useCodeContext();
  const running = data.status === "running";
  const failed = data.status === "error";
  const now = useNow(running);
  const elapsed =
    data.durationMs ?? (running ? Math.max(0, now - Date.parse(data.startedAt)) : null);
  const st = TOOL_STATUS[data.status];

  const session = useSyncStore((s) => s.sessions[sessionId]);
  const host = useSyncStore((s) => (session ? s.hosts[session.hostId] : undefined));
  const stale = isAdapterViewStale(data.adapterGeneration, session?.adapterGeneration);
  const disabled =
    stale ||
    !session ||
    session.readOnly ||
    !!session.archivedAt ||
    host?.connectivity !== "connected";
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const onAction = async (actionId: string) => {
    if (!data.adapterId || disabled || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await codeApi.adapterAction(
        sessionId,
        data.adapterId,
        actionId,
        undefined,
        data.adapterGeneration,
      );
      toast.success("Action sent");
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setActionBusy(false);
    }
  };

  const view = toolViewOf(data, session?.cwd ?? null);
  const label = toolLabel(view, data.name, data.status);
  const [open, setOpen] = useState(!!data.card);
  const inSheet = mobile && !data.card;
  const showElapsed = elapsed !== null && (running || elapsed >= 1000);

  const detail = (
    <ToolDetailView
      data={data}
      view={view}
      output={data.output + (stream?.toolOutput ?? "")}
      pendingArgs={stream?.toolArgs ?? ""}
      facts={[st.label, formatDuration(elapsed)]}
      mobile={mobile}
      openFile={openFile}
      card={
        data.card ? (
          <>
            <UINodeRenderer
              node={data.card}
              onAction={(id) => void onAction(id)}
              onOpenFile={openFile}
              disabled={disabled}
              busy={actionBusy}
            />
            {stale && <p className="text-sm text-muted">{STALE_ADAPTER_VIEW}</p>}
            {actionError && (
              <p role="alert" className="text-sm text-danger">
                {actionError}
              </p>
            )}
          </>
        ) : null
      }
    />
  );

  return (
    <article
      data-testid="tool-row"
      data-kind={view.kind}
      data-status={data.status}
      aria-label={`Tool ${data.name}: ${st.label}`}
      className="min-w-0"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup={inSheet ? "dialog" : undefined}
        onClick={() => setOpen((v) => !v)}
        className="tap flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-surface-2"
      >
        {running ? (
          <Spinner className="size-3.5 text-info" />
        ) : (
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-subtle transition-transform",
              open && !inSheet && "rotate-90",
            )}
          />
        )}
        <span
          className={cn(
            "shrink-0",
            label.mono && "font-mono text-xs",
            failed ? "text-danger" : "text-muted",
          )}
        >
          {label.text}
        </span>
        {view.target && (
          <span className="min-w-0 truncate font-mono text-xs" title={view.target}>
            {view.target}
          </span>
        )}
        {view.stat && (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-success">
              +{view.stat.added}
              <span className="sr-only"> added</span>
            </span>
            {view.stat.removed > 0 && (
              <>
                {" "}
                <span className="text-danger">
                  −{view.stat.removed}
                  <span className="sr-only"> deleted</span>
                </span>
              </>
            )}
          </span>
        )}
        {view.meta.map((m) => (
          <span key={m} className="shrink-0 text-xs text-subtle">
            {m}
          </span>
        ))}
        {failed && <span className="shrink-0 text-xs text-danger">failed</span>}
        {showElapsed && (
          <span className="ml-auto shrink-0 pl-2 text-xs text-subtle tabular-nums">
            {formatDuration(elapsed)}
          </span>
        )}
      </button>
      {inSheet ? (
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          title={`${label.text} ${view.target}`.trim()}
        >
          <div className="flex min-w-0 flex-col gap-2">{detail}</div>
        </Sheet>
      ) : (
        open && (
          <div className="mt-1 mb-1 ml-2.5 flex min-w-0 flex-col gap-2 border-l border-border pl-3">
            {detail}
          </div>
        )
      )}
    </article>
  );
}

/** What opening a tool row shows: facts, the adapter's card, the typed detail, then the output. */
function ToolDetailView({
  data,
  view,
  output,
  pendingArgs,
  facts,
  mobile,
  openFile,
  card,
}: {
  data: ToolItemData;
  view: ToolView;
  output: string;
  /** Arguments still streaming in, before the tool item has them. */
  pendingArgs: string;
  facts: string[];
  mobile: boolean;
  openFile?: (path: string) => void;
  card: ReactNode;
}) {
  const running = data.status === "running";
  // A node from the host or an adapter stands in for what the arguments alone could show.
  const replaced = view.node !== null && (view.detail.t === "edit" || view.detail.t === "args");
  const d = replaced ? ({ t: "node" } as const) : view.detail;
  const showOutput =
    data.status === "error" || (d.t !== "edit" && d.t !== "write" && d.t !== "node");
  const filePath = view.filePath;
  const lineCount = output.replace(/\n+$/, "").split("\n").length;
  const outputNote = running ? "last lines" : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  return (
    <>
      <p className="text-xs text-subtle">
        <span className="font-mono">{data.name}</span>
        {facts.filter(Boolean).map((f) => (
          <span key={f}> · {f}</span>
        ))}
      </p>
      {card}
      {view.node && <UINodeRenderer node={view.node} onOpenFile={openFile} />}
      {d.t === "command" && d.command && <CodeBlock text={`$ ${d.command}`} />}
      {d.t === "edit" &&
        (d.files.length > 0 ? (
          <DiffView files={d.files} />
        ) : (
          <p className="text-xs text-muted">No changes.</p>
        ))}
      {d.t === "write" && d.content && (
        <CodeBlock text={d.content} lang={view.target || undefined} maxHeight="24rem" />
      )}
      {d.t === "read" && d.range && <p className="text-xs text-muted">{d.range}</p>}
      {d.t === "search" && (
        <>
          <CodeBlock text={d.query} />
          {d.where && <p className="text-xs text-muted">in {d.where}</p>}
        </>
      )}
      {d.t === "args" && d.rows.length > 0 && (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {d.rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-xs text-subtle">{k}</dt>
              <dd className="min-w-0 font-mono text-xs break-words whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.t === "args" && d.raw && (
        <details className="group min-w-0">
          <summary className="tap flex cursor-pointer list-none items-center gap-1 text-xs text-muted">
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            Raw arguments
          </summary>
          <CodeBlock text={d.raw} className="mt-1" maxHeight="16rem" />
        </details>
      )}
      {d.t === "args" && d.rows.length === 0 && !d.raw && pendingArgs && (
        <CodeBlock text={pendingArgs} maxHeight="16rem" />
      )}
      {filePath && openFile && (
        <div>
          <TextLink
            size="xs"
            icon={<FileCode aria-hidden className="size-3.5" />}
            onClick={() => openFile(filePath)}
          >
            Open file
          </TextLink>
        </div>
      )}
      {showOutput &&
        (output ? (
          <div className="min-w-0">
            <p className="text-xs text-muted">
              Output <span className="text-subtle">({outputNote})</span>
            </p>
            <CodeBlock
              text={running ? outputPreview(output, 12).text : output}
              lang={view.kind === "read" && view.target ? view.target : undefined}
              className="mt-1"
              maxHeight={mobile ? undefined : "24rem"}
            />
          </div>
        ) : (
          d.t === "command" && !running && <p className="text-xs text-muted">No output.</p>
        ))}
    </>
  );
}

const NOTICE_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const NOTICE_LABEL = { info: "Notice", warning: "Warning", error: "Error" } as const;

function NoticeCard({
  data,
  sessionId,
  readOnly,
}: {
  data: Extract<TranscriptItem, { kind: "notice" }>["data"];
  sessionId: string;
  readOnly: string | null;
}) {
  const { openFile } = useCodeContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncStore((s) => s.sessions[sessionId]);
  const host = useSyncStore((s) => (session ? s.hosts[session.hostId] : undefined));
  const stale = isAdapterViewStale(data.adapterGeneration, session?.adapterGeneration);
  const disabled =
    !!readOnly ||
    stale ||
    !session ||
    session.readOnly ||
    !!session.archivedAt ||
    host?.connectivity !== "connected";
  const action = async (id: string) => {
    if (!data.adapterId || disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await codeApi.adapterAction(sessionId, data.adapterId, id, undefined, data.adapterGeneration);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      data-testid="notice-card"
      className="min-w-0 rounded-md border border-border bg-surface p-3"
    >
      <p className="mb-2 text-xs font-medium text-muted">
        {data.adapterId} · {data.customType ?? "Message"}
      </p>
      {data.card && (
        <UINodeRenderer
          node={data.card}
          onOpenFile={openFile}
          onAction={(id) => void action(id)}
          busy={busy}
          disabled={disabled}
        />
      )}
      {stale && <p className="text-sm text-muted">{STALE_ADAPTER_VIEW}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">Original message</summary>
        <p className="mt-1 whitespace-pre-wrap break-words">{data.text}</p>
      </details>
    </article>
  );
}

function NoticeItem({
  level,
  text,
  repeat,
}: {
  level: "info" | "warning" | "error";
  text: string;
  repeat: number;
}) {
  const Icon = NOTICE_ICON[level];
  return (
    <div
      role={level === "error" ? "alert" : "note"}
      data-testid="notice"
      data-level={level}
      className={cn(
        "flex min-w-0 items-start gap-2 border-l-2 py-0.5 pl-2 text-xs",
        level === "info" && "border-transparent text-subtle",
        level === "warning" && "border-warning text-muted",
        level === "error" && "border-danger text-text",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-px size-3.5 shrink-0",
          level === "warning" && "text-warning",
          level === "error" && "text-danger",
          level === "info" && "text-subtle",
        )}
      />
      <span className="sr-only">{NOTICE_LABEL[level]}: </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          level === "error" ? "break-words whitespace-pre-wrap" : "truncate",
        )}
        title={text}
      >
        {text}
      </span>
      {repeat > 1 && (
        <span className="shrink-0 text-subtle tabular-nums">
          <span aria-hidden>×{repeat}</span>
          <span className="sr-only">(repeated {repeat} times)</span>
        </span>
      )}
    </div>
  );
}

function SystemItem({ text }: { text: string }) {
  return <p className="px-1 text-xs break-words whitespace-pre-wrap text-muted">{text}</p>;
}

function SubagentRow({ data }: { data: Extract<TranscriptItem, { kind: "subagent" }>["data"] }) {
  const status = data.status.toLowerCase();
  const Icon = /run|start|progress/.test(status)
    ? LoaderCircle
    : /fail|error/.test(status)
      ? CircleX
      : /done|complete|success|ok/.test(status)
        ? CircleCheck
        : Network;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 text-sm">
      {Icon === LoaderCircle ? (
        <Spinner className="size-3.5 text-muted" />
      ) : (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
      )}
      <span className="shrink-0 text-muted">Subagent</span>
      <span className="min-w-0 truncate" title={data.label}>
        {data.label}
      </span>
      <span className="shrink-0 text-xs text-subtle">{data.status}</span>
      {data.linkedSessionId ? (
        <TextLink
          to={`/code/${encodeURIComponent(data.linkedSessionId)}`}
          size="xs"
          className="shrink-0"
        >
          Open
        </TextLink>
      ) : (
        <span className="shrink-0 text-xs text-subtle" title={data.sessionFile ?? undefined}>
          Not linked yet
        </span>
      )}
    </div>
  );
}

function InteractionRef({
  interactionId,
  readOnly,
  highlight,
}: {
  interactionId: string;
  readOnly: string | null;
  highlight: boolean;
}) {
  const interaction = useSyncStore((s) => s.interactions[interactionId]);
  if (!interaction) {
    return (
      <p id={interactionDomId(interactionId)} className="px-1 text-xs text-muted">
        Question (details not loaded yet)
      </p>
    );
  }
  return <InteractionEntry interaction={interaction} readOnly={readOnly} highlight={highlight} />;
}

function InteractionEntry({
  interaction,
  readOnly,
  highlight,
}: {
  interaction: Interaction;
  readOnly: string | null;
  highlight: boolean;
}) {
  const pending = interaction.state === "pending";
  const unsupported = isUnsupported(interaction);
  // A pending question is answered in the dock; only a plan's text stays here.
  if (pending && !unsupported && !isDocumentPresentation(interaction.presentation)) return null;
  const card = pending || unsupported;
  return (
    <div
      data-testid={card ? "interaction-card" : "interaction-outcome"}
      data-interaction-id={interaction.id}
      data-state={interaction.state}
      className={cn(
        "min-w-0 scroll-mt-16 transition-shadow",
        highlight && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
      )}
    >
      {card ? (
        <InteractionCard
          id={interactionDomId(interaction.id)}
          interaction={interaction}
          mode={pending && !unsupported ? "reader" : "card"}
          readOnlyReason={
            interaction.state === "pending" || interaction.state === "unsupported" ? readOnly : null
          }
          className="w-full"
        />
      ) : (
        <InteractionOutcome id={interactionDomId(interaction.id)} interaction={interaction} />
      )}
    </div>
  );
}

/** An answered or closed question: one line where it was asked. */
function InteractionOutcome({ id, interaction }: { id: string; interaction: Interaction }) {
  const r = interaction.resolution;
  const outcome = r ? r.summary : interaction.state === "expired" ? "expired" : "canceled";
  const title = r
    ? `${interaction.state === "resolved" ? "Answered" : "Closed"} by ${byLabel(r.by)} ${formatRelative(r.at)}`
    : undefined;
  return (
    <div id={id} className="flex min-w-0 items-start gap-1.5 px-1 text-sm">
      <MessageCircleQuestion aria-hidden className="mt-0.5 size-3.5 shrink-0 text-subtle" />
      <p className="min-w-0 break-words text-muted" title={title}>
        <span className="sr-only">Question: </span>
        {interaction.title}
        <span className="text-text"> · {outcome}</span>
      </p>
    </div>
  );
}

function StreamEntry({ stream }: { stream: StreamBuffer }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(stream.text || stream.thinking) && (
        <AssistantMessage text={stream.text} thinking={stream.thinking} streaming />
      )}
      {(stream.toolArgs || stream.toolOutput) && (
        <div className="min-w-0 rounded-md border border-border bg-surface px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <Spinner className="size-3.5" />
            Tool running…
          </div>
          {stream.toolArgs && (
            <CodeBlock text={stream.toolArgs} className="mt-1" maxHeight="8rem" />
          )}
          {stream.toolOutput && (
            <CodeBlock text={outputPreview(stream.toolOutput).text} className="mt-1" />
          )}
        </div>
      )}
    </div>
  );
}

/** Shown at the end of the transcript while a session's Pi is starting. */
export function StartingCard({
  sessionId,
  detail,
  showPrompt,
}: {
  sessionId: string;
  detail: string | null;
  showPrompt: boolean;
}) {
  const prompt = showPrompt ? initialPromptFor(sessionId) : null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="starting-card"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex items-center gap-2">
        <Spinner className="size-4 text-info" />
        <span className="font-medium">Starting session</span>
      </div>
      <p className="text-sm text-muted">{detail ?? "Starting Pi…"}</p>
      {prompt && (
        <>
          <span className="text-xs font-medium text-muted">
            Your first prompt (sent when Pi is ready)
          </span>
          <div className="line-clamp-6 rounded-md bg-surface-2 px-3 py-2 text-sm break-words whitespace-pre-wrap">
            {prompt}
          </div>
        </>
      )}
    </div>
  );
}
