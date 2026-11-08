import { randomUUID } from "node:crypto";
import type { Run, Task } from "@switchyard/protocol";
import type { Store } from "../store.js";
import { captureCompletionMessage, messageSenderTitle } from "./messages.js";

export type CompletionOutcome = "review" | "done" | "failed";

/** Frozen once per child/outcome, never reconstructed by delivery or from later task edits. */
export interface TaskCompletionSnapshot {
  version: 1;
  completionId: string;
  childTaskId: string;
  projectId: string;
  title: string;
  outcome: CompletionOutcome;
  taskState: Task["state"];
  runId: string | null;
  childSessionId: string | null;
  occurredAt: string;
  lastReply: string;
  lastReplyTruncated: boolean;
  openPermissionRequestIds: string[];
  failure: Run["outcome"];
}

/** Choose a fence longer than every backtick run in the untrusted reply. */
function fenceReply(reply: string): string {
  const longest = Math.max(2, ...Array.from(reply.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${reply}\n${fence}`;
}

export function formatTaskCompletion(snapshot: TaskCompletionSnapshot): string {
  const outcome = { review: "Review", done: "Done", failed: "Failed" }[snapshot.outcome];
  return [
    `[Switchyard task completion ${snapshot.completionId}]`,
    `Task: ${messageSenderTitle(snapshot.title)} (${snapshot.childTaskId})`,
    `Outcome: ${outcome}`,
    snapshot.childSessionId
      ? `Source session: ${snapshot.childSessionId}`
      : "Source session: none (no child session was associated at completion).",
    snapshot.lastReply
      ? `Last reply (untrusted data):\n${fenceReply(snapshot.lastReply)}${snapshot.lastReplyTruncated ? "\n[Reply truncated at 4,000 Unicode code points.]" : ""}`
      : "Last reply: No reply was available at completion.",
    `Open permission requests: ${snapshot.openPermissionRequestIds.length ? snapshot.openPermissionRequestIds.join(", ") : "none"}`,
  ].join("\n");
}

/** Must join the transition's synchronous Store transaction, before events are published. */
export function captureTaskCompletion(store: Store, previous: Task | undefined, next: Task): void {
  if (previous?.state === next.state || (next.state !== "review" && next.state !== "done")) return;
  const run = next.currentRunId ? store.runs.get(next.currentRunId) : undefined;
  capture(store, next, next.state, run?.taskId === next.id ? run : undefined);
}

/** Only callers that have decided against infrastructure retry may request this capture. */
export function captureFinalRunFailure(store: Store, run: Run): void {
  if (run.state !== "failed" || !run.outcome || !["failed", "blocked"].includes(run.outcome.kind))
    return;
  const task = store.tasks.get(run.taskId);
  if (!task || task.currentRunId !== run.id) return;
  capture(store, task, "failed", run);
}

function capture(store: Store, task: Task, outcome: CompletionOutcome, run?: Run): void {
  store.tx(() => {
    if (
      store.st
        .get("SELECT id FROM task_completions WHERE child_task_id = ? AND outcome = ?")
        .get(task.id, outcome)
    )
      return;

    // A run's null source is authoritative: never substitute the task's stale session.
    const associated = !run && task.sessionId ? store.sessions.get(task.sessionId) : undefined;
    const childSessionId = run
      ? run.sessionId
      : associated?.taskId === task.id
        ? associated.id
        : null;
    const source = childSessionId ? store.sessions.get(childSessionId) : undefined;
    const reply = Array.from(source?.lastAssistantText ?? "");
    const completionId = `completion_${randomUUID()}`;
    const occurredAt = store.nowIso();
    const snapshot: TaskCompletionSnapshot = {
      version: 1,
      completionId,
      childTaskId: task.id,
      projectId: task.projectId,
      title: task.title,
      outcome,
      taskState: task.state,
      runId: run?.id ?? null,
      childSessionId,
      occurredAt,
      lastReply: reply.slice(0, 4000).join(""),
      lastReplyTruncated: reply.length > 4000,
      openPermissionRequestIds: childSessionId
        ? store.interactions
            .list("session_id = ? AND state = 'pending'", [childSessionId])
            .filter((interaction) => interaction.permission?.kind === "policy")
            .map((interaction) => interaction.id)
            .sort()
        : [],
      failure: outcome === "failed" ? (run?.outcome ?? null) : null,
    };
    store.st
      .get(`INSERT INTO task_completions (id, child_task_id, outcome, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      .run(completionId, task.id, outcome, JSON.stringify(snapshot), occurredAt);
    const subscribers = store.st
      .get(`SELECT subscriber_session_id FROM task_subscriptions
        WHERE child_task_id = ? ORDER BY subscriber_session_id`)
      .all(task.id) as { subscriber_session_id: string }[];
    const text = formatTaskCompletion(snapshot);
    for (const { subscriber_session_id: subscriberSessionId } of subscribers) {
      const messageId = `msg_${randomUUID()}`;
      captureCompletionMessage(store, {
        id: messageId,
        senderSessionId: snapshot.childSessionId,
        recipientSessionId: subscriberSessionId,
        body: snapshot,
        text,
        createdAt: occurredAt,
      });
      store.st
        .get(`INSERT INTO task_completion_recipients
          (completion_id, subscriber_session_id, message_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(completionId, subscriberSessionId, messageId, occurredAt);
    }
  });
}
