import type { AttentionItem, Interaction, Session } from "@switchyard/protocol";

type Runtime = Session["runtime"];

/** Runtimes whose session may still emit stream deltas. */
const STREAMING = new Set<Runtime>(["starting", "running", "waiting_input"]);
/** Runtimes with an attached Pi process (includes idle). */
const LIVE = new Set<Runtime>(["starting", "idle", "running", "waiting_input"]);
/** A turn is in progress (steer/follow-up rather than prompt). */
const BUSY = new Set<Runtime>(["running", "waiting_input"]);

export const isStreamingRuntime = (r: Runtime) => STREAMING.has(r);
export const isLiveRuntime = (r: Runtime) => LIVE.has(r);
export const isBusyRuntime = (r: Runtime) => BUSY.has(r);

export const isPendingInteraction = (i: Pick<Interaction, "state">) => i.state === "pending";

/** Pending interactions of one session, oldest first. */
export function pendingInteractionsFor(
  interactions: Record<string, Interaction>,
  sessionId: string,
): Interaction[] {
  return Object.values(interactions)
    .filter((i) => i.sessionId === sessionId && isPendingInteraction(i))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Pending interactions across a set of sessions, oldest first. */
export function pendingInteractionsForSessions(
  interactions: Record<string, Interaction>,
  sessionIds: ReadonlySet<string>,
): Interaction[] {
  return Object.values(interactions)
    .filter((i) => isPendingInteraction(i) && sessionIds.has(i.sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function countPendingInteractions(
  interactions: Record<string, Interaction>,
  sessionId: string,
): number {
  let n = 0;
  for (const i of Object.values(interactions)) {
    if (i.sessionId === sessionId && isPendingInteraction(i)) n++;
  }
  return n;
}

/** Open = not resolved (acknowledged or not). */
export const isOpenAttention = (a: Pick<AttentionItem, "resolvedAt">) => !a.resolvedAt;

/** Shown on the Attention badge and the "New" filter: open and not yet acknowledged. */
export const isUnacknowledgedAttention = (
  a: Pick<AttentionItem, "resolvedAt" | "acknowledgedAt">,
) => !a.resolvedAt && !a.acknowledgedAt;

/** Session ids flagged "Needs input": open attention (acknowledged included) or a pending interaction. */
export function sessionsNeedingAttention(
  attention: Record<string, AttentionItem>,
  interactions: Record<string, Interaction>,
): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(attention)) {
    if (a.sessionId && isOpenAttention(a)) out.add(a.sessionId);
  }
  for (const i of Object.values(interactions)) if (isPendingInteraction(i)) out.add(i.sessionId);
  return out;
}
