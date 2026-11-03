import type {
  AttentionItem,
  Eligibility,
  Interaction,
  Priority,
  Run,
  Task,
} from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUp,
  CircleAlert,
  Clock,
  type LucideIcon,
  Minus,
} from "lucide-react";
import { useMemo } from "react";
import type { StatusInfo } from "../../components/ui/StatusChip";
import { RUN_STATUS } from "../../components/ui/StatusChip";
import { useSyncStore } from "../../sync/store";
import { WAIT_LABELS } from "./logic";

export const PRIORITY_INFO: Record<Priority, StatusInfo> = {
  0: { label: PRIORITY_LABELS[0], icon: ChevronsUp, tone: "danger" },
  1: { label: PRIORITY_LABELS[1], icon: ArrowUp, tone: "warning" },
  2: { label: PRIORITY_LABELS[2], icon: Minus, tone: "neutral" },
  3: { label: PRIORITY_LABELS[3], icon: ArrowDown, tone: "neutral" },
};

export interface TaskInfo {
  run: Run | undefined;
  hostName: string | null;
  hostOffline: boolean;
  branch: string | null;
  projectName: string | null;
  attention: AttentionItem[];
  pendingInteraction: Interaction | undefined;
}

/** Derived, display-only facts about a task (current run, host, branch, attention). */
export function useTaskInfo(task: Task | undefined): TaskInfo {
  const runs = useSyncStore((s) => s.runs);
  const hosts = useSyncStore((s) => s.hosts);
  const sessions = useSyncStore((s) => s.sessions);
  const workspaces = useSyncStore((s) => s.workspaces);
  const projects = useSyncStore((s) => s.projects);
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  return useMemo(() => {
    if (!task)
      return {
        run: undefined,
        hostName: null,
        hostOffline: false,
        branch: null,
        projectName: null,
        attention: [],
        pendingInteraction: undefined,
      };
    const run = task.currentRunId ? runs[task.currentRunId] : undefined;
    const session = task.sessionId ? sessions[task.sessionId] : undefined;
    const hostId = run?.hostId ?? session?.hostId ?? task.policy.hostId ?? null;
    const host = hostId ? hosts[hostId] : undefined;
    const ws = session?.workspaceId ? workspaces[session.workspaceId] : undefined;
    const branch =
      ws?.branch ??
      (task.policy.workspace.mode === "new_worktree" ? task.policy.workspace.branch : null) ??
      (task.policy.workspace.mode === "existing"
        ? (workspaces[task.policy.workspace.workspaceId]?.branch ?? null)
        : null);
    const items = Object.values(attention).filter(
      (a) =>
        !a.resolvedAt &&
        (a.taskId === task.id || (!!task.sessionId && a.sessionId === task.sessionId)),
    );
    const pendingInteraction = task.sessionId
      ? Object.values(interactions)
          .filter((i) => i.sessionId === task.sessionId && i.state === "pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      : undefined;
    return {
      run,
      hostName: host?.name ?? null,
      hostOffline: !!host && host.connectivity !== "connected",
      branch: branch ?? null,
      projectName: projects[task.projectId]?.name ?? null,
      attention: items,
      pendingInteraction,
    };
  }, [task, runs, hosts, sessions, workspaces, projects, attention, interactions]);
}

export interface ExecutionLine {
  icon: LucideIcon;
  text: string;
  tone: StatusInfo["tone"];
  spin?: boolean;
  pulse?: boolean;
}

/** One line describing what is happening now (or why it is blocked/waiting). */
export function executionLine(
  task: Task,
  run: Run | undefined,
  wait: Eligibility | undefined,
): ExecutionLine | null {
  if (task.blocked)
    return { icon: CircleAlert, text: `Blocked: ${task.blocked.reason}`, tone: "danger" };
  if (task.state === "in_progress" && run) {
    const s = RUN_STATUS[run.state];
    const control = run.controlMode === "human" ? " · You have control" : "";
    return {
      icon: s.icon,
      text: `${s.label}${control}`,
      tone: s.tone,
      spin: s.spin,
      pulse: s.pulse,
    };
  }
  if (task.state === "ready") {
    if (wait && !wait.eligible)
      return { icon: Clock, text: wait.message || WAIT_LABELS[wait.wait], tone: "warning" };
    if (wait?.eligible) return { icon: Clock, text: `Starting on ${wait.hostName}`, tone: "info" };
    return { icon: Clock, text: "Queued for dispatch", tone: "neutral" };
  }
  if (task.state === "review") {
    if (task.review.changesRequested)
      return { icon: CircleAlert, text: "Changes requested", tone: "warning" };
    if (run?.outcome)
      return {
        icon: RUN_STATUS.succeeded.icon,
        text: run.outcome.summary || "Ready for review",
        tone: "info",
      };
    return { icon: RUN_STATUS.succeeded.icon, text: "Ready for review", tone: "info" };
  }
  return null;
}
