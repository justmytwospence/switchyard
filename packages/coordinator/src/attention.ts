import {
  type AttentionItem,
  type AttentionReason,
  newId,
  SwitchyardError,
} from "@switchyard/protocol";
import type { EventHub } from "./event-hub.js";
import type { Store } from "./store.js";

export interface RaiseInput {
  reason: AttentionReason;
  summary: string;
  sessionId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  severity?: AttentionItem["severity"];
  interactionId?: string | null;
  deepLink?: string;
}

const DEFAULT_SEVERITY: Record<AttentionReason, AttentionItem["severity"]> = {
  needs_input: "warning",
  failed: "critical",
  ready_for_review: "info",
  unsupported_interaction: "warning",
  host_unreachable: "critical",
};

/** Deep link per the plan: input -> session + interaction, review/failed -> task, else session. */
export function deepLinkFor(i: {
  reason: AttentionReason;
  sessionId?: string | null;
  taskId?: string | null;
  interactionId?: string | null;
}): string {
  if (i.reason === "needs_input" && i.sessionId && i.interactionId) {
    return `/code/${i.sessionId}?interaction=${i.interactionId}`;
  }
  if ((i.reason === "ready_for_review" || i.reason === "failed") && i.taskId) {
    return `/tasks/${i.taskId}`;
  }
  if (i.sessionId) return `/code/${i.sessionId}`;
  if (i.taskId) return `/tasks/${i.taskId}`;
  return "/attention";
}

/**
 * Attention items: one open item per (sessionId or taskId, reason). Emits `attention.raised` for
 * new items and `attention.resolved` after commit; the notification router subscribes to those.
 */
export class AttentionService {
  constructor(
    private readonly store: Store,
    private readonly hub: EventHub,
  ) {}

  open(filter: { sessionId?: string | null; taskId?: string | null; reason?: AttentionReason }) {
    const where: string[] = ["resolved_at IS NULL"];
    const params: string[] = [];
    if (filter.sessionId) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    } else if (filter.taskId) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.reason) {
      where.push("reason = ?");
      params.push(filter.reason);
    }
    return this.store.attention.list(where.join(" AND "), params, "created_at");
  }

  /** Raise or refresh the open item for this scope and reason. Joins the caller's transaction. */
  raise(input: RaiseInput): AttentionItem {
    return this.store.tx(() => {
      let projectId = input.projectId ?? null;
      let taskId = input.taskId ?? null;
      if (input.sessionId && (!projectId || !taskId)) {
        const s = this.store.sessions.get(input.sessionId);
        projectId ??= s?.projectId ?? null;
        taskId ??= s?.taskId ?? null;
      }
      if (!projectId && taskId) projectId = this.store.tasks.get(taskId)?.projectId ?? null;
      const scope = input.sessionId
        ? { sessionId: input.sessionId }
        : input.taskId
          ? { taskId: input.taskId }
          : null;
      if (!scope) throw new SwitchyardError("internal", "Attention needs a session or task");
      const existing = this.open({ ...scope, reason: input.reason })[0];
      const base = {
        sessionId: input.sessionId ?? null,
        taskId,
        projectId,
        reason: input.reason,
        severity: input.severity ?? DEFAULT_SEVERITY[input.reason],
        summary: input.summary,
        interactionId: input.interactionId ?? null,
      };
      const deepLink = input.deepLink ?? deepLinkFor(base);
      if (existing) {
        const updated: AttentionItem = { ...existing, ...base, deepLink };
        if (JSON.stringify(updated) === JSON.stringify(existing)) return existing;
        return this.store.putAttention(updated);
      }
      const item: AttentionItem = {
        id: newId("att"),
        ...base,
        deepLink,
        acknowledgedAt: null,
        resolvedAt: null,
        createdAt: this.store.nowIso(),
      };
      this.store.putAttention(item);
      this.store.afterCommit(() => this.hub.emit("attention.raised", item));
      return item;
    });
  }

  /** Resolve open items matching the filter. */
  resolve(filter: {
    sessionId?: string | null;
    taskId?: string | null;
    reason?: AttentionReason;
    interactionId?: string;
  }): AttentionItem[] {
    return this.store.tx(() => {
      const items = this.open(filter).filter(
        (a) => !filter.interactionId || a.interactionId === filter.interactionId,
      );
      const now = this.store.nowIso();
      const out: AttentionItem[] = [];
      for (const a of items) {
        const resolved = this.store.putAttention({ ...a, resolvedAt: now });
        out.push(resolved);
        this.store.afterCommit(() => this.hub.emit("attention.resolved", resolved));
      }
      return out;
    });
  }

  acknowledge(id: string): AttentionItem {
    return this.store.tx(() => {
      const a = this.store.attention.require(id);
      if (a.acknowledgedAt) return a;
      return this.store.putAttention({ ...a, acknowledgedAt: this.store.nowIso() });
    });
  }
}
