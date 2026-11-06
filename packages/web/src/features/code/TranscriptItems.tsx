import type { Interaction, ToolItemData, TranscriptItem } from "@switchyard/protocol";
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Info,
  LoaderCircle,
  type LucideIcon,
  Network,
  TriangleAlert,
  User,
  Wand2,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { CodeBlock } from "../../components/intent/CodeBlock";
import { InteractionCard } from "../../components/intent/InteractionCard";
import { Markdown } from "../../components/intent/Markdown";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { Button } from "../../components/ui/Button";
import { copyText } from "../../components/ui/Copy";
import { Sheet } from "../../components/ui/Overlay";
import { Spinner } from "../../components/ui/Spinner";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatDuration, formatTime } from "../../lib/time";
import { useSmoothText } from "../../lib/useSmoothText";
import { errorMessage } from "../../sync/api";
import type { StreamBuffer } from "../../sync/store";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import { useCodeContext } from "./context";
import { useNow } from "./hooks";
import {
  formatWorkSummary,
  interactionDomId,
  outputPreview,
  stringifyArgs,
  type TimelineEntry,
  type WorkSummary,
} from "./model";
import { initialPromptFor } from "./startingPrompts";

export interface TimelineRowProps {
  entry: TimelineEntry;
  sessionId: string;
  /** Answer controls are hidden with this explanation (read-only view, host offline). */
  interactionReadOnly: string | null;
  draftEmpty: boolean;
  onUseSuggestion: (text: string) => void;
  highlightInteractionId: string | null;
}

/** A finished turn's tool calls and thinking folded into one summary row. */
export function WorkRow({
  entries,
  summary,
  ...rest
}: Omit<TimelineRowProps, "entry"> & { entries: TimelineEntry[]; summary: WorkSummary }) {
  return (
    <details data-testid="work-row" className="group min-w-0">
      <summary className="tap flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        <Wrench aria-hidden className="size-3.5" />
        {formatWorkSummary(summary)}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {entries.map((e) => (
          <TimelineRow key={e.key} entry={e} {...rest} />
        ))}
      </div>
    </details>
  );
}

/** One transcript entry. */
export function TimelineRow(props: TimelineRowProps) {
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
      return <UserMessage item={item} />;
    case "assistant":
      return (
        <AssistantMessage
          text={item.data.text + (stream?.text ?? "")}
          thinking={stream?.thinking ?? ""}
          streaming={!!stream || item.data.streaming === true}
        />
      );
    case "thinking":
      return <ThinkingItem text={item.data.text + (stream?.thinking ?? "")} live={!!stream} />;
    case "tool":
      return <ToolCard data={item.data} stream={stream} sessionId={props.sessionId} />;
    case "notice":
      return (
        <NoticeItem level={item.data.level} text={item.data.text} repeat={entry.repeat ?? 1} />
      );
    case "system":
      return (
        <SystemItem
          text={item.data.text}
          suggestion={item.data.suggestion === true}
          draftEmpty={props.draftEmpty}
          onUse={props.onUseSuggestion}
        />
      );
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

function RowLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

function UserMessage({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2">
      <RowLabel icon={User}>
        You <span className="font-normal text-subtle">· {formatTime(item.at)}</span>
      </RowLabel>
      <p className="text-sm break-words whitespace-pre-wrap">{item.data.text}</p>
      {item.data.images ? (
        <p className="mt-1 text-xs text-muted">
          {item.data.images} image{item.data.images === 1 ? "" : "s"} attached
        </p>
      ) : null}
    </div>
  );
}

function AssistantMessage({
  text,
  thinking,
  streaming,
}: {
  text: string;
  thinking: string;
  streaming: boolean;
}) {
  const shownText = useSmoothText(text, streaming);
  const shownThinking = useSmoothText(thinking, streaming);
  return (
    <div className="min-w-0 px-1">
      <RowLabel icon={Bot}>
        Pi
        {streaming && (
          <span className="inline-flex items-center gap-1 font-normal">
            <Spinner className="size-3" />
            Writing…
          </span>
        )}
      </RowLabel>
      {thinking && <ThinkingItem text={shownThinking} live />}
      {text ? <Markdown text={shownText} /> : !thinking && <p className="text-sm text-muted">…</p>}
    </div>
  );
}

function ThinkingItem({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="group min-w-0 rounded-md border border-border bg-surface px-3 py-1.5">
      <summary className="tap flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        <Brain aria-hidden className="size-3.5" />
        {live ? "Thinking…" : "Thinking"}
      </summary>
      <p className="mt-1 text-xs break-words whitespace-pre-wrap text-muted">{text}</p>
    </details>
  );
}

const TOOL_STATUS: Record<ToolItemData["status"], { label: string; icon: LucideIcon }> = {
  running: { label: "Running", icon: LoaderCircle },
  ok: { label: "Done", icon: CircleCheck },
  error: { label: "Failed", icon: CircleX },
};

/** Restrained tool card: name, status (icon + text), summary, elapsed, expandable args/output. */
export function ToolCard({
  data,
  stream,
  sessionId,
}: {
  data: ToolItemData;
  stream: StreamBuffer | null;
  sessionId: string;
}) {
  const { mobile, openFile } = useCodeContext();
  const [fullOutput, setFullOutput] = useState(false);
  const running = data.status === "running";
  const now = useNow(running);
  const elapsed =
    data.durationMs ?? (running ? Math.max(0, now - Date.parse(data.startedAt)) : null);
  const st = TOOL_STATUS[data.status];
  const Icon = st.icon;
  const args = stringifyArgs(data.args) || stream?.toolArgs || "";
  const output = data.output + (stream?.toolOutput ?? "");
  const preview = outputPreview(output);

  const onAction = (actionId: string) => {
    if (!data.adapterId) return;
    codeApi
      .adapterAction(sessionId, data.adapterId, actionId)
      .then(() => toast.success("Action sent"))
      .catch((e) => toast.error(errorMessage(e)));
  };

  return (
    <article
      data-testid="tool-card"
      aria-label={`Tool ${data.name}: ${st.label}`}
      className="min-w-0 rounded-md border border-border bg-surface"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2">
        {running ? (
          <Spinner className="size-4 text-info" />
        ) : (
          <Icon
            aria-hidden
            className={cn(
              "size-4 shrink-0",
              data.status === "ok" && "text-success",
              data.status === "error" && "text-danger",
            )}
          />
        )}
        <span className="min-w-0 truncate font-mono text-sm font-medium">{data.name}</span>
        <span
          className={cn(
            "text-xs",
            data.status === "error" ? "text-danger" : running ? "text-info" : "text-muted",
          )}
        >
          {st.label}
        </span>
        {elapsed !== null && (
          <span className="ml-auto text-xs text-subtle tabular-nums">
            {formatDuration(elapsed)}
          </span>
        )}
        {data.summary && (
          <p className="w-full min-w-0 truncate text-xs text-muted" title={data.summary}>
            {data.summary}
          </p>
        )}
      </header>
      {data.card && (
        <div className="border-t border-border px-3 py-2">
          <UINodeRenderer node={data.card} onAction={onAction} onOpenFile={openFile} />
        </div>
      )}
      {(args || output) && (
        <div className="flex flex-col gap-1 border-t border-border px-3 py-1.5">
          {args && (
            <details className="group min-w-0">
              <summary className="tap flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform group-open:rotate-90"
                />
                Arguments
              </summary>
              <CodeBlock text={args} className="mt-1" maxHeight="16rem" />
            </details>
          )}
          {output &&
            (mobile ? (
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted">
                  Output{preview.truncated ? " (last lines)" : ""}
                </div>
                <CodeBlock text={preview.text} className="mt-1" />
                {preview.truncated && (
                  <Button size="sm" variant="ghost" onClick={() => setFullOutput(true)}>
                    Show full output
                  </Button>
                )}
                <Sheet
                  open={fullOutput}
                  onClose={() => setFullOutput(false)}
                  title={`${data.name} output`}
                >
                  <CodeBlock text={output} />
                </Sheet>
              </div>
            ) : (
              <details className="group min-w-0">
                <summary className="tap flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted">
                  <ChevronRight
                    aria-hidden
                    className="size-3.5 transition-transform group-open:rotate-90"
                  />
                  Output
                  <span className="font-normal text-subtle">
                    ({output.split("\n").length} lines)
                  </span>
                </summary>
                <CodeBlock text={output} className="mt-1" maxHeight="24rem" />
              </details>
            ))}
        </div>
      )}
    </article>
  );
}

const NOTICE_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const NOTICE_LABEL = { info: "Notice", warning: "Warning", error: "Error" } as const;

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

function SystemItem({
  text,
  suggestion,
  draftEmpty,
  onUse,
}: {
  text: string;
  suggestion: boolean;
  draftEmpty: boolean;
  onUse: (text: string) => void;
}) {
  if (!suggestion) {
    return <p className="px-1 text-xs break-words whitespace-pre-wrap text-muted">{text}</p>;
  }
  return (
    <div className="min-w-0 rounded-md border border-dashed border-border-strong px-3 py-2">
      <RowLabel icon={Wand2}>Suggested next message</RowLabel>
      <p className="text-sm break-words whitespace-pre-wrap">{text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!draftEmpty} onClick={() => onUse(text)}>
          Use suggestion
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy className="size-3.5" />}
          onClick={() => void copyText(text, "Copied")}
        >
          Copy
        </Button>
        {!draftEmpty && (
          <span className="text-xs text-muted">
            Your draft is not empty; clear it to use this suggestion.
          </span>
        )}
      </div>
    </div>
  );
}

function SubagentRow({ data }: { data: Extract<TranscriptItem, { kind: "subagent" }>["data"] }) {
  const linked = useSyncStore((s) =>
    data.linkedSessionId ? s.sessions[data.linkedSessionId] : undefined,
  );
  const status = data.status.toLowerCase();
  const Icon = /run|start|progress/.test(status)
    ? LoaderCircle
    : /fail|error/.test(status)
      ? CircleX
      : /done|complete|success|ok/.test(status)
        ? CircleCheck
        : Network;
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface px-3 py-2">
      {Icon === LoaderCircle ? (
        <Spinner className="mt-0.5 size-4 text-muted" />
      ) : (
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium text-muted">Subagent</span>
          <span className="min-w-0 truncate text-sm font-medium">{data.label}</span>
          <span className="text-xs text-muted">{data.status}</span>
        </div>
        {data.linkedSessionId ? (
          <TextLink to={`/code/${encodeURIComponent(data.linkedSessionId)}`} size="sm">
            Open {linked?.title ?? "subagent session"}
          </TextLink>
        ) : (
          <p className="text-xs break-all text-muted">
            {data.sessionFile ? `Session file: ${data.sessionFile}` : "Session not linked yet."}
          </p>
        )}
        <p className="text-xs text-muted">Subagent: view only. Live control is not supported.</p>
      </div>
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
  return (
    <div
      data-testid="interaction-card"
      data-interaction-id={interaction.id}
      data-state={interaction.state}
      className={cn(
        "min-w-0 scroll-mt-16 transition-shadow",
        highlight && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
      )}
    >
      <InteractionCard
        id={interactionDomId(interaction.id)}
        interaction={interaction}
        readOnlyReason={
          interaction.state === "pending" || interaction.state === "unsupported" ? readOnly : null
        }
        className="w-full"
      />
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
