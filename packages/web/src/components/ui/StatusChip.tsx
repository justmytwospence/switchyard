import type {
  AttentionReason,
  Connectivity,
  InteractionState,
  OccurrenceState,
  RunState,
  RuntimeState,
  TaskState,
} from "@switchyard/protocol";
import {
  Activity,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CirclePlay,
  CircleSlash,
  CircleX,
  Clock,
  CloudOff,
  Eye,
  Hourglass,
  Inbox,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestion,
  RefreshCw,
  Repeat,
  Square,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ConnectionState } from "../../sync/store";
import { TONE_CLASSES, type Tone } from "./Badge";
import { Spinner } from "./Spinner";

/** A status presentation: always an icon plus a text label (never color alone). */
export interface StatusInfo {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** Spin the icon (in-flight states). */
  spin?: boolean;
  /** Pulse the icon (ongoing, not transitional). */
  pulse?: boolean;
}

export const RUNTIME_STATUS: Record<RuntimeState, StatusInfo> = {
  starting: { label: "Starting…", icon: LoaderCircle, tone: "info", spin: true },
  idle: { label: "Idle", icon: CircleDot, tone: "neutral" },
  running: { label: "Running", icon: Activity, tone: "info", pulse: true },
  waiting_input: { label: "Needs input", icon: MessageCircleQuestion, tone: "warning" },
  interrupted: { label: "Interrupted", icon: CirclePause, tone: "warning" },
  failed: { label: "Failed", icon: CircleX, tone: "danger" },
  stopped: { label: "Stopped", icon: Square, tone: "neutral" },
};

export const TASK_STATUS: Record<TaskState, StatusInfo> = {
  backlog: { label: "Backlog", icon: Inbox, tone: "neutral" },
  ready: { label: "Ready", icon: CirclePlay, tone: "info" },
  in_progress: { label: "In progress", icon: LoaderCircle, tone: "info" },
  review: { label: "Review", icon: Eye, tone: "warning" },
  done: { label: "Done", icon: CircleCheck, tone: "success" },
  canceled: { label: "Canceled", icon: Ban, tone: "neutral" },
};

export const RUN_STATUS: Record<RunState, StatusInfo> = {
  queued: { label: "Queued", icon: Clock, tone: "neutral" },
  dispatching: { label: "Dispatching…", icon: LoaderCircle, tone: "info", spin: true },
  uncertain: { label: "Awaiting host confirmation", icon: Hourglass, tone: "warning" },
  running: { label: "Running", icon: Activity, tone: "info", pulse: true },
  waiting_input: { label: "Needs input", icon: MessageCircleQuestion, tone: "warning" },
  checking: { label: "Running checks", icon: ListChecks, tone: "info", spin: false },
  succeeded: { label: "Succeeded", icon: CircleCheck, tone: "success" },
  failed: { label: "Failed", icon: CircleX, tone: "danger" },
  interrupted: { label: "Interrupted", icon: CirclePause, tone: "warning" },
  canceled: { label: "Canceled", icon: Ban, tone: "neutral" },
};

/** Host connectivity. */
export const HOST_STATUS: Record<Connectivity, StatusInfo> = {
  connected: { label: "Connected", icon: Wifi, tone: "success" },
  reconnecting: { label: "Reconnecting…", icon: RefreshCw, tone: "warning", spin: true },
  unreachable: { label: "Unreachable", icon: WifiOff, tone: "danger" },
};

/** This client's link to the coordinator. */
export const CONNECTION_STATUS: Record<ConnectionState, StatusInfo> = {
  connecting: { label: "Connecting…", icon: LoaderCircle, tone: "info", spin: true },
  live: { label: "Live", icon: Wifi, tone: "success" },
  reconnecting: { label: "Reconnecting…", icon: RefreshCw, tone: "warning", spin: true },
  offline: { label: "Offline", icon: CloudOff, tone: "danger" },
};

export const INTERACTION_STATUS: Record<InteractionState, StatusInfo> = {
  pending: { label: "Needs your answer", icon: MessageCircleQuestion, tone: "warning" },
  resolved: { label: "Answered", icon: CircleCheck, tone: "success" },
  expired: { label: "Expired", icon: Hourglass, tone: "neutral" },
  cancelled: { label: "Cancelled", icon: CircleSlash, tone: "neutral" },
  unsupported: { label: "Unsupported here", icon: TriangleAlert, tone: "warning" },
};

export const ATTENTION_STATUS: Record<AttentionReason, StatusInfo> = {
  needs_input: { label: "Needs input", icon: MessageCircleQuestion, tone: "warning" },
  failed: { label: "Failed", icon: CircleX, tone: "danger" },
  ready_for_review: { label: "Ready for review", icon: Eye, tone: "info" },
  unsupported_interaction: {
    label: "Unsupported interaction",
    icon: TriangleAlert,
    tone: "warning",
  },
  host_unreachable: { label: "Host unreachable", icon: WifiOff, tone: "danger" },
};

export const OCCURRENCE_STATUS: Record<OccurrenceState, StatusInfo> = {
  fired: { label: "Fired", icon: CirclePlay, tone: "info" },
  skipped_overlap: { label: "Skipped (overlap)", icon: CircleSlash, tone: "neutral" },
  skipped_missed: { label: "Skipped (missed)", icon: CircleSlash, tone: "neutral" },
  queued: { label: "Queued", icon: Clock, tone: "neutral" },
  appended: { label: "Appended", icon: Repeat, tone: "info" },
  failed: { label: "Failed", icon: CircleX, tone: "danger" },
  filtered: { label: "Filtered out", icon: CircleDashed, tone: "neutral" },
};

export type StatusChipProps =
  | { kind: "runtime"; value: RuntimeState; label?: string; className?: string; size?: "sm" | "md" }
  | { kind: "task"; value: TaskState; label?: string; className?: string; size?: "sm" | "md" }
  | { kind: "run"; value: RunState; label?: string; className?: string; size?: "sm" | "md" }
  | { kind: "host"; value: Connectivity; label?: string; className?: string; size?: "sm" | "md" }
  | {
      kind: "connection";
      value: ConnectionState;
      label?: string;
      className?: string;
      size?: "sm" | "md";
    }
  | {
      kind: "interaction";
      value: InteractionState;
      label?: string;
      className?: string;
      size?: "sm" | "md";
    }
  | {
      kind: "attention";
      value: AttentionReason;
      label?: string;
      className?: string;
      size?: "sm" | "md";
    }
  | {
      kind: "occurrence";
      value: OccurrenceState;
      label?: string;
      className?: string;
      size?: "sm" | "md";
    }
  | { kind: "custom"; status: StatusInfo; label?: string; className?: string; size?: "sm" | "md" };

const FALLBACK: StatusInfo = { label: "Unknown", icon: CircleAlert, tone: "neutral" };

export function statusInfo(props: StatusChipProps): StatusInfo {
  switch (props.kind) {
    case "runtime":
      return RUNTIME_STATUS[props.value] ?? FALLBACK;
    case "task":
      return TASK_STATUS[props.value] ?? FALLBACK;
    case "run":
      return RUN_STATUS[props.value] ?? FALLBACK;
    case "host":
      return HOST_STATUS[props.value] ?? FALLBACK;
    case "connection":
      return CONNECTION_STATUS[props.value] ?? FALLBACK;
    case "interaction":
      return INTERACTION_STATUS[props.value] ?? FALLBACK;
    case "attention":
      return ATTENTION_STATUS[props.value] ?? FALLBACK;
    case "occurrence":
      return OCCURRENCE_STATUS[props.value] ?? FALLBACK;
    case "custom":
      return props.status;
  }
}

/** Status pill: icon + text label, tone only reinforces. `label` overrides the text. */
export function StatusChip(props: StatusChipProps) {
  const info = statusInfo(props);
  const Icon = info.icon;
  const sm = props.size === "sm";
  return (
    <span
      data-status-chip={props.kind}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border font-medium whitespace-nowrap",
        sm ? "px-1.5 text-xs leading-5" : "px-2 text-xs leading-6",
        TONE_CLASSES[info.tone],
        props.className,
      )}
    >
      {info.spin ? (
        <Spinner className={sm ? "size-3" : "size-3.5"} />
      ) : (
        <Icon
          aria-hidden
          className={cn(sm ? "size-3" : "size-3.5", "shrink-0", info.pulse && "animate-pulse")}
        />
      )}
      <span className="truncate">{props.label ?? info.label}</span>
    </span>
  );
}

/** Icon plus text status, the tone only reinforces. */
export function InlineStatus({
  icon: Icon,
  label,
  tone = "neutral",
  spin,
  className,
}: {
  icon: LucideIcon;
  label: ReactNode;
  tone?: Tone;
  spin?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 text-xs leading-6 font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {spin ? <Spinner className="size-3.5" /> : <Icon aria-hidden className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
