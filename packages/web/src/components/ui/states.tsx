import {
  CircleAlert,
  Inbox,
  MessageCircleQuestion,
  Puzzle,
  RefreshCw,
  ServerOff,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { formatRelative, formatTime } from "../../lib/time";
import type { ConnectionState } from "../../sync/store";
import { Button, buttonClasses, Spinner } from "./Button";

/*
 * The nine UI states every primary view implements (spec 18):
 * LoadingState, EmptyState, ReconnectingBanner, HostUnavailable,
 * InteractionPending, UnsupportedCapability, ErrorState, FatalError, and
 * toast() for successful mutations (see Toast.tsx).
 */

export type StateAction =
  | { label: string; onClick: () => void; icon?: ReactNode }
  | { label: string; to: string; icon?: ReactNode };

function ActionButton({ action, primary = true }: { action: StateAction; primary?: boolean }) {
  if ("to" in action) {
    return (
      <Link to={action.to} className={buttonClasses(primary ? "primary" : "secondary")}>
        {action.icon}
        {action.label}
      </Link>
    );
  }
  return (
    <Button variant={primary ? "primary" : "secondary"} icon={action.icon} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

function Panel({
  icon,
  title,
  children,
  actions,
  className,
  role,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-center gap-3 px-4 py-10 text-center",
        className,
      )}
    >
      <div className="text-muted" aria-hidden>
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {children && <div className="text-sm text-muted">{children}</div>}
      {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

/** 1. Initial loading. */
export function LoadingState({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted",
        className,
      )}
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** 2. Empty state with a next action. */
export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: StateAction;
  secondaryAction?: StateAction;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Panel
      icon={icon ?? <Inbox className="size-8" />}
      title={title}
      className={className}
      actions={
        (action || secondaryAction) && (
          <>
            {action && <ActionButton action={action} />}
            {secondaryAction && <ActionButton action={secondaryAction} primary={false} />}
          </>
        )
      }
    >
      {description}
    </Panel>
  );
}

/** 3. Reconnecting with last-known-data indication. Renders nothing while live. */
export function ReconnectingBanner({
  state,
  lastSyncedAt,
  onRetry,
  className,
}: {
  state: ConnectionState;
  lastSyncedAt: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  if (state === "live" || (state === "connecting" && !lastSyncedAt)) return null;
  const offline = state === "offline";
  const when = lastSyncedAt ? formatTime(lastSyncedAt) : "an earlier session";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 border-b border-border bg-warning-soft px-3 py-1.5 text-sm text-text",
        className,
      )}
    >
      {offline ? (
        <ServerOff aria-hidden className="size-4 shrink-0 text-warning" />
      ) : (
        <RefreshCw aria-hidden className="size-4 shrink-0 animate-spin text-warning" />
      )}
      <span className="min-w-0 flex-1">
        {offline ? "Offline" : "Reconnecting…"} showing last known data from{" "}
        <time dateTime={lastSyncedAt ?? undefined}>{when}</time>
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="tap shrink-0 rounded px-2 py-0.5 font-medium text-accent hover:bg-surface-2"
        >
          Retry now
        </button>
      )}
    </div>
  );
}

/** 4. Host unavailable (unreachable or reconnecting). Never claims completion. */
export function HostUnavailable({
  hostName,
  connectivity = "unreachable",
  lastSeenAt,
  detail,
  compact,
  className,
}: {
  hostName: string;
  connectivity?: "reconnecting" | "unreachable";
  lastSeenAt?: string | null;
  detail?: ReactNode;
  /** Inline banner instead of a full panel. */
  compact?: boolean;
  className?: string;
}) {
  const title =
    connectivity === "reconnecting"
      ? `Host ${hostName} is reconnecting`
      : `Host ${hostName} is unreachable`;
  const body = (
    <>
      {lastSeenAt ? `Last seen ${formatRelative(lastSeenAt)}. ` : ""}
      {detail ?? "Work on this host keeps its last known state; nothing is restarted elsewhere."}
    </>
  );
  if (compact) {
    return (
      <div
        role="status"
        className={cn(
          "flex items-start gap-2 rounded-md border border-border bg-danger-soft px-3 py-2 text-sm",
          className,
        )}
      >
        <ServerOff aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="text-muted">{body}</div>
        </div>
      </div>
    );
  }
  return (
    <Panel
      role="status"
      icon={<ServerOff className="size-8" />}
      title={title}
      className={className}
    >
      {body}
    </Panel>
  );
}

/** 5. Permission/interaction pending: a strip linking to the first unanswered item. */
export function InteractionPending({
  count,
  to,
  onOpen,
  label,
  className,
}: {
  count: number;
  to?: string;
  onOpen?: () => void;
  label?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  const text = label ?? (count === 1 ? "Needs your answer" : `${count} questions need your answer`);
  const inner = (
    <>
      <MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate font-medium">{text}</span>
      <span className="shrink-0 text-accent">Answer</span>
    </>
  );
  const cls = cn(
    "tap flex w-full items-center gap-2 border border-border bg-warning-soft px-3 py-2 text-left text-sm rounded-md",
    className,
  );
  if (to)
    return (
      <Link to={to} className={cls} role="status">
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={onOpen} className={cls}>
      {inner}
    </button>
  );
}

/** 6. Unsupported capability: says exactly what is not available and what to do instead. */
export function UnsupportedCapability({
  capability,
  reason,
  fallback,
  className,
}: {
  capability: string;
  reason: ReactNode;
  fallback?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm",
        className,
      )}
    >
      <Puzzle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
      <div className="min-w-0">
        <div className="font-medium">{capability} is not available here</div>
        <div className="text-muted">{reason}</div>
        {fallback && <div className="mt-1">{fallback}</div>}
      </div>
    </div>
  );
}

/** 7. Recoverable error with retry. */
export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
  compact,
  className,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-start gap-2 rounded-md border border-border bg-danger-soft px-3 py-2 text-sm",
          className,
        )}
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          {message && <div className="break-words text-muted">{message}</div>}
        </div>
        {onRetry && (
          <Button size="sm" onClick={onRetry} icon={<RefreshCw className="size-3.5" />}>
            Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <Panel
      role="alert"
      icon={<TriangleAlert className="size-8 text-danger" />}
      title={title}
      className={className}
      actions={
        onRetry && (
          <Button variant="primary" onClick={onRetry} icon={<RefreshCw className="size-4" />}>
            Retry
          </Button>
        )
      }
    >
      <span className="break-words">{message}</span>
    </Panel>
  );
}

/** 8. Irrecoverable error with a diagnostics link. */
export function FatalError({
  title = "Switchyard cannot show this view",
  error,
  diagnosticsHref = "/settings/diagnostics",
  className,
}: {
  title?: string;
  error: unknown;
  diagnosticsHref?: string;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    <Panel
      role="alert"
      icon={<CircleAlert className="size-8 text-danger" />}
      title={title}
      className={className}
      actions={
        <>
          <a href={diagnosticsHref} className={buttonClasses("primary")}>
            Open diagnostics
          </a>
          <Button onClick={() => location.reload()}>Reload</Button>
        </>
      }
    >
      <span className="break-words">{message}</span>
    </Panel>
  );
}
