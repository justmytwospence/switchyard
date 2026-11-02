import type { AttentionItem, AttentionReason } from "@switchyard/protocol";
import { Bell, CircleCheck, ExternalLink, Eye, ListTodo, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ROUTES } from "../../app/routes";
import { InteractionCard } from "../../components/intent/InteractionCard";
import { Button, buttonClasses } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ATTENTION_STATUS, StatusChip } from "../../components/ui/StatusChip";
import {
  EmptyState,
  ErrorState,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { useFilter } from "../../prefs";
import { apiPost, errorMessage } from "../../sync/api";
import { useConnection, useOpenAttention, useSyncStore } from "../../sync/store";

export const ATTENTION_GROUPS: AttentionReason[] = [
  "needs_input",
  "failed",
  "ready_for_review",
  "unsupported_interaction",
  "host_unreachable",
];

const GROUP_HINT: Record<AttentionReason, string> = {
  needs_input: "Answer here; the answer goes to the same runtime question.",
  failed: "Runs that failed or were blocked. Open the task to see why.",
  ready_for_review: "Finished runs waiting for your review.",
  unsupported_interaction:
    "Questions this client cannot display. Answer them in a terminal attached to the session.",
  host_unreachable:
    "Running work on hosts that stopped responding. Nothing is restarted elsewhere.",
};

/** Group open attention by reason, keeping newest first within a group. */
export function groupAttention(items: AttentionItem[]): Record<AttentionReason, AttentionItem[]> {
  const out = Object.fromEntries(ATTENTION_GROUPS.map((r) => [r, [] as AttentionItem[]])) as Record<
    AttentionReason,
    AttentionItem[]
  >;
  for (const a of items) out[a.reason]?.push(a);
  return out;
}

/** /attention: Needs input, Failed, Ready for review (plus unsupported and unreachable). */
export default function AttentionView() {
  const all = useOpenAttention();
  const hydrated = useSyncStore((s) => s.hydrated);
  const connection = useConnection();
  const [show, setShow] = useFilter<"all" | "new">("attention", "all");
  const items = useMemo(
    () => (show === "new" ? all.filter((a) => !a.acknowledgedAt) : all),
    [all, show],
  );
  const groups = useMemo(() => groupAttention(items), [items]);

  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-4 safe-pt">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">Attention</h1>
        <SegmentedControl
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: "All open" },
            { value: "new", label: "Not acknowledged" },
          ]}
        />
      </header>
      {connection.state !== "live" && hydrated && (
        <p className="text-sm text-muted" role="status">
          Showing the last known attention items; answers are sent once the connection is back.
        </p>
      )}
      {!hydrated ? (
        <LoadingState label="Loading attention…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Bell className="size-8" />}
          title={all.length > 0 ? "Nothing new" : "Nothing needs your attention"}
          description={
            all.length > 0
              ? `${all.length} acknowledged ${all.length === 1 ? "item is" : "items are"} still open.`
              : "Questions, failures and finished work show up here."
          }
          action={
            all.length > 0
              ? { label: "Show all open", onClick: () => setShow("all") }
              : { label: "Go to Board", to: ROUTES.board }
          }
        />
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
                  <li key={a.id}>
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
      toast.success(
        "Acknowledged. It stays open until the underlying task or question is resolved.",
      );
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
          <InteractionCard interaction={interaction} />
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
      action = (
        <UnsupportedCapability
          capability="This question"
          reason="The extension uses a terminal-only dialog. Attach a terminal to the Pi session to answer it, or stop the session."
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

  return (
    <article
      aria-label={`${ATTENTION_STATUS[item.reason].label}: ${task?.title ?? session?.title ?? item.summary}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusChip kind="attention" value={item.reason} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm text-muted">
          {[
            project?.name,
            task?.title,
            session && session.title !== task?.title ? session.title : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Switchyard"}
        </span>
        <time dateTime={item.createdAt} className="shrink-0 text-xs text-subtle">
          {formatRelative(item.createdAt)}
        </time>
      </div>
      <p className="min-w-0 text-sm break-words">{item.summary}</p>
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
            Acknowledged {formatRelative(item.acknowledgedAt)}
          </span>
        ) : (
          <Button
            size="sm"
            busy={busy}
            onClick={() => void acknowledge()}
            title="Hide the alert without resolving the task"
          >
            Acknowledge
          </Button>
        )}
      </div>
      {ackError !== null && (
        <ErrorState
          compact
          title="Could not acknowledge"
          error={errorMessage(ackError)}
          onRetry={() => void acknowledge()}
        />
      )}
    </article>
  );
}
