import type { AttentionItem, AttentionReason } from "@switchyard/protocol";
import { Bell, CircleCheck, ExternalLink, Eye, History, ListTodo, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes";
import { InteractionCard, isDocumentPresentation } from "../../components/intent/InteractionCard";
import { Button, buttonClasses } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ATTENTION_STATUS, StatusChip } from "../../components/ui/StatusChip";
import {
  EmptyState,
  ErrorState,
  HostUnavailable,
  LastKnownNote,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { useFilter } from "../../prefs";
import { apiPost, errorMessage } from "../../sync/api";
import { useOpenAttention, useSyncStore } from "../../sync/store";
import {
  ATTENTION_GROUPS,
  type AttentionShow,
  attentionMeta,
  groupAttention,
  normalizeShow,
  visibleAttention,
} from "./logic";
import { HISTORY_LIMIT, useAttentionHistory } from "./useAttentionHistory";

const GROUP_HINT: Record<AttentionReason, string> = {
  needs_input: "Questions from Pi waiting for your answer.",
  failed: "Runs that failed or were blocked. Open the task to see why.",
  ready_for_review: "Finished runs waiting for your review.",
  unsupported_interaction:
    "Questions this client cannot display. Answer them in a terminal attached to the session.",
  host_unreachable:
    "Running work on hosts that stopped responding. Nothing is restarted elsewhere.",
};

/** /attention: Needs input, Failed, Ready for review (plus unsupported and unreachable). */
export default function AttentionView() {
  const all = useOpenAttention();
  const hydrated = useSyncStore((s) => s.hydrated);
  const [stored, setStored] = useFilter<AttentionShow | "all">("attentionShow", "open");
  const show = normalizeShow(stored);
  const setShow = (v: AttentionShow) => setStored(v);
  const items = useMemo(() => visibleAttention(all, show), [all, show]);
  const dismissedCount = useMemo(() => visibleAttention(all, "dismissed").length, [all]);
  const groups = useMemo(() => groupAttention(items), [items]);
  const history = useAttentionHistory(show === "history");

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-4 pb-4 safe-pt-4 md:px-6">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">Attention</h1>
        <SegmentedControl
          label="Show"
          className="max-sm:w-full max-sm:basis-full"
          value={show}
          onChange={setShow}
          options={[
            { value: "open", label: "Open" },
            { value: "dismissed", label: "Dismissed" },
            { value: "history", label: "History" },
          ]}
        />
      </header>
      <LastKnownNote
        subject="attention items"
        consequence="Answers are sent once the connection is back."
        show={hydrated}
      />
      {show === "history" ? (
        <div data-testid="attention-history" className="flex min-w-0 flex-col gap-2">
          {!history.data && history.loading ? (
            <LoadingState label="Loading history…" />
          ) : !history.data && history.error ? (
            <ErrorState
              compact
              title="Could not load history"
              error={errorMessage(history.error)}
              onRetry={history.reload}
            />
          ) : !history.data || history.data.length === 0 ? (
            <EmptyState
              icon={<History className="size-8" />}
              title="No history yet"
              description="Resolved questions, failures and reviews show up here."
            />
          ) : (
            <>
              <ul className="flex min-w-0 flex-col gap-2">
                {history.data.map((a) => (
                  <li key={a.id} className="min-w-0">
                    <HistoryRow item={a} />
                  </li>
                ))}
              </ul>
              {history.data.length >= HISTORY_LIMIT && (
                <p className="text-sm text-muted">Showing the {HISTORY_LIMIT} most recent.</p>
              )}
            </>
          )}
        </div>
      ) : !hydrated ? (
        <LoadingState label="Loading attention…" />
      ) : items.length === 0 ? (
        show === "dismissed" ? (
          <EmptyState
            icon={<Bell className="size-8" />}
            title="No dismissed items"
            description="Items you dismiss stay here until their question or task is resolved."
            action={{ label: "Show open", onClick: () => setShow("open") }}
          />
        ) : (
          <EmptyState
            icon={<Bell className="size-8" />}
            title={dismissedCount > 0 ? "All caught up" : "Nothing needs your attention"}
            description={
              dismissedCount > 0
                ? `${dismissedCount} dismissed ${dismissedCount === 1 ? "item is" : "items are"} still open.`
                : "Questions, failures and finished work show up here."
            }
            action={
              dismissedCount > 0
                ? { label: "Show dismissed", onClick: () => setShow("dismissed") }
                : { label: "Go to Sessions", to: ROUTES.code }
            }
            secondaryAction={
              dismissedCount > 0
                ? { label: "Go to Sessions", to: ROUTES.code }
                : { label: "Go to Board", to: ROUTES.board }
            }
          />
        )
      ) : (
        ATTENTION_GROUPS.filter((r) => groups[r].length > 0).map((reason) => {
          const info = ATTENTION_STATUS[reason];
          const Icon = info.icon;
          return (
            <section
              key={reason}
              data-testid={`attention-group-${reason}`}
              aria-labelledby={`att-${reason}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <div>
                <h2
                  id={`att-${reason}`}
                  className="flex items-center gap-2 text-base font-semibold"
                >
                  <Icon aria-hidden className="size-4 text-muted" />
                  {info.label}
                  <span className="text-sm font-normal text-muted">({groups[reason].length})</span>
                </h2>
                <p className="text-sm text-muted">{GROUP_HINT[reason]}</p>
              </div>
              <ul className="flex min-w-0 flex-col gap-2">
                {groups[reason].map((a) => (
                  <li key={a.id} className="min-w-0">
                    <AttentionRow item={a} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const project = useSyncStore((s) => (item.projectId ? s.projects[item.projectId] : undefined));
  const task = useSyncStore((s) => (item.taskId ? s.tasks[item.taskId] : undefined));
  const session = useSyncStore((s) => (item.sessionId ? s.sessions[item.sessionId] : undefined));
  const host = useSyncStore((s) => (session ? s.hosts[session.hostId] : undefined));
  const interaction = useSyncStore((s) =>
    item.interactionId ? s.interactions[item.interactionId] : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [ackError, setAckError] = useState<unknown>(null);

  const acknowledge = async () => {
    setBusy(true);
    setAckError(null);
    try {
      const res = await apiPost<AttentionItem>(
        `/api/attention/${encodeURIComponent(item.id)}/acknowledge`,
      );
      const next =
        res && typeof res === "object" && "id" in res
          ? res
          : { ...item, acknowledgedAt: new Date().toISOString() };
      useSyncStore.setState((s) =>
        s.attention[item.id] ? { attention: { ...s.attention, [item.id]: next } } : {},
      );
      toast.success("Dismissed. It stays under All until the task or question is resolved.");
    } catch (e) {
      setAckError(e);
    } finally {
      setBusy(false);
    }
  };

  const sessionHref = item.sessionId
    ? item.interactionId
      ? ROUTES.interaction(item.sessionId, item.interactionId)
      : ROUTES.session(item.sessionId)
    : null;
  const hostOffline = !!host && host.connectivity !== "connected";

  let action: React.ReactNode = null;
  switch (item.reason) {
    case "needs_input":
      action =
        interaction && interaction.state === "pending" ? (
          <InteractionCard
            flush
            interaction={interaction}
            readOnlyReason={
              hostOffline
                ? `Host ${host?.name} is offline. You can answer once it reconnects.`
                : session?.readOnly
                  ? "This session is read-only."
                  : null
            }
          />
        ) : interaction ? (
          <InteractionCard flush interaction={interaction} />
        ) : sessionHref ? (
          <Link to={sessionHref} className={buttonClasses("primary", "sm")}>
            <ExternalLink aria-hidden className="size-3.5" />
            Answer in session
          </Link>
        ) : null;
      break;
    case "failed":
      action = item.taskId ? (
        <Link to={ROUTES.task(item.taskId)} className={buttonClasses("primary", "sm")}>
          <ListTodo aria-hidden className="size-3.5" />
          Open task
        </Link>
      ) : null;
      break;
    case "ready_for_review":
      action = item.sessionId ? (
        <Link
          to={`${ROUTES.session(item.sessionId)}?tab=changes`}
          className={buttonClasses("primary", "sm")}
        >
          <Eye aria-hidden className="size-3.5" />
          Review changes
        </Link>
      ) : item.taskId ? (
        <Link to={ROUTES.task(item.taskId)} className={buttonClasses("primary", "sm")}>
          <Eye aria-hidden className="size-3.5" />
          Open review
        </Link>
      ) : null;
      break;
    case "unsupported_interaction":
      action = interaction ? (
        <InteractionCard
          interaction={interaction}
          readOnlyReason={
            hostOffline
              ? `Host ${host?.name} is offline. You can choose once it reconnects.`
              : session?.readOnly
                ? "This session is read-only."
                : null
          }
        />
      ) : (
        <UnsupportedCapability
          capability="This dialog"
          reason="An extension opened a terminal-only dialog. In RPC mode Pi gave it no answer, so the extension continued without one."
        />
      );
      break;
    case "host_unreachable":
      action = host ? (
        <HostUnavailable
          compact
          hostName={host.name}
          connectivity={host.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
          lastSeenAt={host.lastSeenAt}
        />
      ) : null;
      break;
  }

  const metaText = attentionMeta(project, task, session);

  const showsCard =
    !!interaction && (item.reason === "needs_input" || item.reason === "unsupported_interaction");

  // A plan awaiting approval gets the whole width: one meta line, no card around it.
  if (
    item.reason === "needs_input" &&
    interaction?.state === "pending" &&
    isDocumentPresentation(interaction.presentation)
  ) {
    return (
      <article
        aria-label={`Plan awaiting approval: ${metaText}`}
        className="flex min-w-0 flex-col gap-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span className="min-w-0 basis-full truncate sm:basis-auto sm:flex-1">{metaText}</span>
          {sessionHref && (
            <Link to={sessionHref} className={buttonClasses("ghost", "sm")}>
              <ExternalLink aria-hidden className="size-3.5" />
              Open session
            </Link>
          )}
          <time dateTime={item.createdAt} className="shrink-0 text-xs text-subtle sm:ml-auto">
            {formatRelative(item.createdAt)}
          </time>
          {!item.acknowledgedAt && (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => void acknowledge()}>
              Dismiss
            </Button>
          )}
        </div>
        {action}
        {ackError !== null && (
          <ErrorState
            compact
            title="Could not dismiss"
            error={errorMessage(ackError)}
            onRetry={() => void acknowledge()}
          />
        )}
      </article>
    );
  }

  return (
    <article
      aria-label={`${ATTENTION_STATUS[item.reason].label}: ${task?.title ?? session?.title ?? item.summary}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusChip kind="attention" value={item.reason} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{metaText}</span>
        <time dateTime={item.createdAt} className="shrink-0 text-xs text-subtle">
          {formatRelative(item.createdAt)}
        </time>
      </div>
      {!showsCard && <p className="min-w-0 text-sm break-words">{item.summary}</p>}
      {action && <div className="flex min-w-0 flex-col items-start">{action}</div>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {item.reason !== "failed" && item.taskId && (
          <Link to={ROUTES.task(item.taskId)} className={buttonClasses("ghost", "sm")}>
            <ListTodo aria-hidden className="size-3.5" />
            Task
          </Link>
        )}
        {sessionHref && (
          <Link to={sessionHref} className={buttonClasses("ghost", "sm")}>
            <ExternalLink aria-hidden className="size-3.5" />
            Open session
          </Link>
        )}
        {item.reason === "host_unreachable" && host && (
          <Link
            to={`${ROUTES.settings("hosts")}/${encodeURIComponent(host.id)}`}
            className={buttonClasses("ghost", "sm")}
          >
            <Server aria-hidden className="size-3.5" />
            Host details
          </Link>
        )}
        <span className="ml-auto" />
        {item.acknowledgedAt ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <CircleCheck aria-hidden className="size-3.5" />
            Dismissed {formatRelative(item.acknowledgedAt)}
          </span>
        ) : (
          <Button size="sm" busy={busy} onClick={() => void acknowledge()}>
            Dismiss
          </Button>
        )}
      </div>
      {ackError !== null && (
        <ErrorState
          compact
          title="Could not dismiss"
          error={errorMessage(ackError)}
          onRetry={() => void acknowledge()}
        />
      )}
    </article>
  );
}

function HistoryRow({ item }: { item: AttentionItem }) {
  const project = useSyncStore((s) => (item.projectId ? s.projects[item.projectId] : undefined));
  const task = useSyncStore((s) => (item.taskId ? s.tasks[item.taskId] : undefined));
  const session = useSyncStore((s) => (item.sessionId ? s.sessions[item.sessionId] : undefined));
  return (
    <article
      aria-label={`${ATTENTION_STATUS[item.reason].label}: ${task?.title ?? session?.title ?? item.summary}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusChip kind="attention" value={item.reason} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {attentionMeta(project, task, session)}
        </span>
        {item.resolvedAt && (
          <time dateTime={item.resolvedAt} className="shrink-0 text-xs text-subtle">
            Resolved {formatRelative(item.resolvedAt)}
          </time>
        )}
      </div>
      <p className="min-w-0 text-sm break-words">{item.summary}</p>
      {(item.taskId || item.sessionId) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {item.taskId && (
            <Link to={ROUTES.task(item.taskId)} className={buttonClasses("ghost", "sm")}>
              <ListTodo aria-hidden className="size-3.5" />
              Task
            </Link>
          )}
          {item.sessionId && (
            <Link to={ROUTES.session(item.sessionId)} className={buttonClasses("ghost", "sm")}>
              <ExternalLink aria-hidden className="size-3.5" />
              Open session
            </Link>
          )}
        </div>
      )}
    </article>
  );
}
