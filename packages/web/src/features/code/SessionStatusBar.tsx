import {
  Archive,
  ArchiveRestore,
  Bot,
  CirclePause,
  CircleX,
  Eye,
  Hand,
  type LucideIcon,
  MessageCircleQuestion,
  Play,
  ServerOff,
  Square,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { TextLink } from "../../components/ui/TextLink";
import { cn } from "../../lib/cn";
import { usePendingInteractions } from "../../sync/store";
import { type SessionContext, useNow } from "./hooks";
import { type SessionStatus, type SessionStatusAction, sessionStatus } from "./model";
import type { SessionActions } from "./SessionActions";

const ICON: Record<SessionStatus["kind"], LucideIcon> = {
  subagent: Eye,
  archived: Archive,
  host: ServerOff,
  answer: MessageCircleQuestion,
  failed: CircleX,
  interrupted: CirclePause,
  stopped: Square,
  starting: Square,
  compacting: Square,
  automation: Bot,
  human: Hand,
};
const ACTION_ICON: Record<SessionStatusAction, LucideIcon> = {
  unarchive: ArchiveRestore,
  answer: MessageCircleQuestion,
  resume: Play,
  takeover: Hand,
  return: Bot,
};
const TONE = {
  neutral: { row: "border-border-strong bg-surface-2", icon: "text-muted" },
  info: { row: "border-info bg-surface-2", icon: "text-info" },
  warning: { row: "border-warning bg-warning-soft", icon: "text-warning" },
  danger: { row: "border-danger bg-danger-soft", icon: "text-danger" },
} as const;

/** The session's one status line, directly above the composer: one message, one action. */
export function SessionStatusBar({
  ctx,
  actions,
  onAnswer,
}: {
  ctx: SessionContext;
  actions: SessionActions;
  onAnswer: () => void;
}) {
  const pending = usePendingInteractions(ctx.session.id);
  const now = useNow(ctx.link === "unreachable", 30_000);
  const status = sessionStatus({
    session: ctx.session,
    hostLink: ctx.link,
    hostName: ctx.hostName,
    hostLastSeenAt: ctx.host?.lastSeenAt,
    control: ctx.control,
    pending,
    canResume: actions.canResume,
    now,
  });
  if (!status) return null;
  const Icon = ICON[status.kind];
  const tone = TONE[status.tone];
  const act = status.action;
  const run =
    act &&
    {
      unarchive: actions.unarchive,
      answer: onAnswer,
      resume: actions.resume,
      takeover: actions.takeover,
      return: actions.returnToAutomation,
    }[act.kind];
  const busy = act
    ? {
        unarchive: actions.busy.unarchive,
        answer: false,
        resume: actions.busy.resume,
        takeover: actions.busy.takeover,
        return: actions.busy.ret,
      }[act.kind]
    : false;
  const ActIcon = act ? ACTION_ICON[act.kind] : null;
  return (
    <div className="shrink-0 px-3 pb-2 md:px-6">
      <div
        data-testid="session-status"
        data-kind={status.kind}
        role={status.tone === "danger" ? "alert" : "status"}
        className={cn(
          "mx-auto flex w-full max-w-[80ch] min-w-0 items-center gap-2 rounded-md border-l-2 px-3 py-1.5 text-sm",
          tone.row,
        )}
      >
        {status.pending ? (
          <Spinner className={cn("size-4 shrink-0", tone.icon)} />
        ) : (
          <Icon aria-hidden className={cn("size-4 shrink-0", tone.icon)} />
        )}
        <span className="min-w-0 flex-1 break-words">{status.text}</span>
        {status.link && (
          <TextLink to={status.link.to} size="xs" className="shrink-0">
            {status.link.label}
          </TextLink>
        )}
        {act && run && (
          <Button
            size="sm"
            variant={act.kind === "return" ? "secondary" : "primary"}
            className="shrink-0"
            icon={ActIcon ? <ActIcon className="size-3.5" /> : undefined}
            busy={busy}
            onClick={run}
          >
            {act.label}
          </Button>
        )}
      </div>
    </div>
  );
}
