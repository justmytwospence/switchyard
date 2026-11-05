import {
  type Automation,
  type AutomationInput,
  type AutomationPreview,
  type Occurrence,
  WebhookTokenResponse,
} from "@switchyard/protocol";
import {
  CircleCheck,
  CircleDashed,
  Copy,
  Eye,
  KeyRound,
  ListChecks,
  Play,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { copyText } from "../../components/ui/Copy";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { PriorityLabel } from "../../components/ui/Priority";
import { StatusChip } from "../../components/ui/StatusChip";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiGet, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { automationPath } from "./controls";
import {
  curlExample,
  formatAbsolute,
  mergeOccurrences,
  normalizeHistory,
  occurrenceTime,
} from "./describe";

const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;

/** True for "this endpoint does not exist on this coordinator". */
function isMissingEndpoint(e: unknown): boolean {
  return isApiError(e) && (e.status === 404 || e.status === 405 || e.status === 501);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export function SummaryPanel({ summary, errorCount }: { summary: string; errorCount: number }) {
  return (
    <Card stack title="Summary" testId="automation-summary">
      <p className="text-sm break-words">{summary}</p>
      {errorCount > 0 && (
        <p className="flex items-center gap-1.5 text-sm text-danger">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          {errorCount === 1 ? "1 field needs attention" : `${errorCount} fields need attention`}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; preview: AutomationPreview; key: string }
  | { status: "error"; error: unknown }
  | { status: "unsupported" };

/**
 * A saved automation without local edits previews through `GET /api/automations/:id/preview`;
 * a new or edited draft posts its current form to `POST /api/automations/preview`.
 */
async function fetchPreview(
  id: string | null,
  body: AutomationInput,
  dirty: boolean,
): Promise<AutomationPreview> {
  if (id && !dirty) return apiGet<AutomationPreview>(automationPath(id, "/preview"));
  return apiPost<AutomationPreview>("/api/automations/preview", body);
}

/**
 * "Preview resulting task": renders the template and the next five
 * occurrence times for the current (possibly unsaved) draft.
 */
export function PreviewPanel({
  automationId,
  dirty,
  getInput,
  currentKey,
}: {
  automationId: string | null;
  /** The form differs from the saved automation (preview the draft, not the saved version). */
  dirty: boolean;
  /** Validates the draft (showing inline errors) and returns the body, or null. */
  getInput: () => AutomationInput | null;
  /** Serialized current draft, to flag a stale preview. */
  currentKey: string;
}) {
  const [state, setState] = useState<PreviewState>({ status: "idle" });

  const run = async () => {
    const input = getInput();
    if (!input) {
      toast.error("Fix the highlighted fields to preview the task");
      return;
    }
    setState({ status: "loading" });
    try {
      const preview = await fetchPreview(automationId, input, dirty);
      setState({ status: "done", preview, key: JSON.stringify(input) });
    } catch (e) {
      setState(isMissingEndpoint(e) ? { status: "unsupported" } : { status: "error", error: e });
    }
  };

  return (
    <Card
      stack
      title="Preview"
      description="See the task an occurrence would create, and when it would run next."
      testId="automation-preview"
    >
      <div>
        <Button
          icon={<Eye className="size-4" />}
          busy={state.status === "loading"}
          onClick={() => void run()}
        >
          Preview resulting task
        </Button>
      </div>
      {state.status === "unsupported" && (
        <UnsupportedCapability
          capability="Task preview"
          reason="This coordinator does not offer automation previews."
          fallback="Read the summary above, or save and use Run now to see a real task."
        />
      )}
      {state.status === "error" && (
        <ErrorState
          compact
          title="Could not preview"
          error={state.error}
          onRetry={() => void run()}
        />
      )}
      {state.status === "done" && (
        <PreviewResult preview={state.preview} stale={state.key !== currentKey} />
      )}
    </Card>
  );
}

function PreviewResult({ preview, stale }: { preview: AutomationPreview; stale: boolean }) {
  const { task } = preview;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {stale && (
        <p className="flex items-center gap-1.5 text-xs text-warning" role="status">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          The form changed since this preview. Preview again to refresh it.
        </p>
      )}
      <p className="text-sm break-words text-muted">{preview.summary}</p>
      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-2 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 font-medium break-words">{task.title}</h3>
          <PriorityLabel priority={task.priority} muted className="shrink-0 text-xs" />
        </div>
        {task.objective ? (
          <p className="text-sm break-words whitespace-pre-wrap">{task.objective}</p>
        ) : (
          <p className="text-sm text-muted">No objective.</p>
        )}
        {task.acceptanceCriteria.length > 0 && (
          <div>
            <h4 className="flex items-center gap-1 text-xs font-medium text-muted">
              <ListChecks aria-hidden className="size-3.5" />
              Acceptance criteria
            </h4>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {task.acceptanceCriteria.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: criteria may repeat
                <li key={i} className="break-words">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium">Next occurrences</h3>
        {preview.next.length === 0 ? (
          <p className="text-sm text-muted">
            No scheduled times: this trigger fires on demand, on a webhook, or when a task is done.
          </p>
        ) : (
          <ol className="mt-1 flex flex-col gap-0.5 text-sm">
            {preview.next.slice(0, 5).map((iso) => (
              <li key={iso} className="flex flex-wrap gap-x-2">
                <time dateTime={iso}>{formatAbsolute(iso)}</time>
                <span className="text-muted">{formatRelative(iso)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Webhook token                                                       */
/* ------------------------------------------------------------------ */

function CopyField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex min-w-0 items-start gap-2">
        <code
          className={`min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-xs break-all select-all ${mono ? "font-mono" : ""}`}
        >
          {value}
        </code>
        <Button
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={() => void copyText(value, `${label} copied`)}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

/** Create or rotate the webhook token; the token is shown once. */
export function WebhookSection({ automation }: { automation: Automation }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<{ token: string; url: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const hasToken = automation.webhookTokenSet || issued !== null;

  const issue = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const res = await apiPost<unknown>(automationPath(automation.id, "/webhook-token"));
      const parsed = WebhookTokenResponse.safeParse(res);
      if (!parsed.success) throw new Error("The coordinator returned an unexpected token response");
      const url = new URL(parsed.data.url, window.location.origin).toString();
      setIssued({ token: parsed.data.token, url });
      toast.success(hasToken ? "Webhook token rotated" : "Webhook token created");
    } catch (e) {
      if (isMissingEndpoint(e)) setUnsupported(true);
      else toast.error(`Could not issue a webhook token: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      stack
      title="Webhook"
      description="POST JSON to the URL with the token as a Bearer header. Filters decide which payloads fire."
      testId="webhook-token"
    >
      <p className="flex items-center gap-1.5 text-sm">
        {hasToken ? (
          <>
            <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />A token is set
          </>
        ) : (
          <>
            <CircleDashed aria-hidden className="size-4 shrink-0 text-muted" />
            No token yet: webhook calls are rejected until you create one
          </>
        )}
      </p>
      {unsupported ? (
        <UnsupportedCapability
          capability="Webhook tokens"
          reason="This coordinator does not issue webhook tokens."
        />
      ) : (
        <div>
          <Button
            icon={<KeyRound className="size-4" />}
            busy={busy}
            onClick={() => (hasToken ? setConfirm(true) : void issue())}
          >
            {hasToken ? "Rotate token" : "Create token"}
          </Button>
        </div>
      )}
      {issued && (
        <div
          role="alert"
          className="flex min-w-0 flex-col gap-3 rounded-md border border-warning bg-warning-soft p-3"
        >
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
            This token is shown once. Copy it now.
          </p>
          <CopyField label="Token" value={issued.token} />
          <CopyField label="URL" value={issued.url} />
          <CopyField label="Example" value={curlExample(issued.token, issued.url)} />
          <div>
            <Button size="sm" onClick={() => setIssued(null)}>
              I have copied it
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Rotate webhook token?"
        description="The current token stops working immediately. Update every sender with the new token."
        confirmLabel="Rotate token"
        busy={busy}
        onConfirm={() => void issue()}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

type HistoryState =
  | { status: "loading" }
  | { status: "done"; items: Occurrence[] }
  | { status: "error"; error: unknown }
  | { status: "unsupported" };

const NO_OCCURRENCES: Occurrence[] = [];

/** Occurrence history (separate from the board): REST history merged with live occurrences. */
export function HistorySection({
  automationId,
  refreshKey,
  onRun,
}: {
  automationId: string;
  refreshKey: number;
  onRun: () => void;
}) {
  const live = useSyncStore((s) => s.occurrences[automationId] ?? NO_OCCURRENCES);
  const tasks = useSyncStore((s) => s.tasks);
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState((s) => (s.status === "done" ? s : { status: "loading" }));
      try {
        const res = await apiGet<unknown>(automationPath(automationId, "/history"), {}, signal);
        setState({ status: "done", items: normalizeHistory(res) });
      } catch (e) {
        if (signal?.aborted) return;
        setState(isMissingEndpoint(e) ? { status: "unsupported" } : { status: "error", error: e });
      }
    },
    [automationId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers a reload
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, refreshKey]);

  const items = mergeOccurrences(state.status === "done" ? state.items : [], live);

  return (
    <Card
      stack
      title="History"
      description="Occurrences of this automation. Routine successes are hidden from the board and appear only here."
      testId="automation-history"
    >
      {state.status === "unsupported" && (
        <UnsupportedCapability
          capability="Automation history"
          reason="This coordinator does not serve stored history; only occurrences seen live in this session are shown."
        />
      )}
      {state.status === "error" && (
        <ErrorState
          compact
          title="Could not load history"
          error={state.error}
          onRetry={() => void load()}
        />
      )}
      {state.status === "loading" && items.length === 0 ? (
        <LoadingState label="Loading history…" className="py-4" />
      ) : items.length === 0 && state.status !== "error" ? (
        <EmptyState
          className="py-4"
          icon={<ScrollText className="size-6" />}
          title="No occurrences yet"
          description="Occurrences appear here when the trigger fires or you run it."
          action={{ label: "Run now", onClick: onRun, icon: <Play className="size-4" /> }}
        />
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {items.map((o) => {
            const when = occurrenceTime(o);
            const task = o.taskId ? tasks[o.taskId] : undefined;
            const text = [o.reason, o.outcome].filter(Boolean).join(" · ");
            return (
              <li key={o.id} className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusChip kind="occurrence" value={o.state} size="sm" />
                  <time dateTime={when} className="text-sm">
                    {formatAbsolute(when)}
                  </time>
                  <span className="text-xs text-muted">{formatRelative(when)}</span>
                </div>
                {text && <p className="text-sm break-words text-muted">{text}</p>}
                {o.taskId && (
                  <Link
                    to={taskPath(o.taskId)}
                    className="tap inline-flex min-w-0 items-center gap-1 self-start text-sm text-accent hover:underline"
                  >
                    <span className="min-w-0 truncate">
                      {task ? `Task: ${task.title}` : "Open task"}
                    </span>
                    {task?.hiddenFromBoard && (
                      <span className="shrink-0 text-xs text-muted">(hidden from board)</span>
                    )}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
