import type { AttentionItem, AttentionReason, Project, Session, Task } from "@switchyard/protocol";

export const ATTENTION_GROUPS: AttentionReason[] = [
  "needs_input",
  "failed",
  "ready_for_review",
  "unsupported_interaction",
  "host_unreachable",
];

/** Group open attention by reason, keeping the input order within a group. */
export function groupAttention(items: AttentionItem[]): Record<AttentionReason, AttentionItem[]> {
  const out = Object.fromEntries(ATTENTION_GROUPS.map((r) => [r, [] as AttentionItem[]])) as Record<
    AttentionReason,
    AttentionItem[]
  >;
  for (const a of items) out[a.reason]?.push(a);
  return out;
}

export type AttentionShow = "open" | "dismissed" | "history";

/** Stored prefs from before History: "all" (open + dismissed) and unknown values read as "open". */
export function normalizeShow(v: unknown): AttentionShow {
  return v === "dismissed" || v === "history" ? v : "open";
}

/** Unacknowledged items for "open", acknowledged for "dismissed"; [] for "history". */
export function visibleAttention(all: AttentionItem[], show: AttentionShow): AttentionItem[] {
  if (show === "history") return [];
  return all.filter((a) => (show === "open" ? !a.acknowledgedAt : !!a.acknowledgedAt));
}

/** "project · task · session" (session only when its title differs from the task's), else "Switchyard". */
export function attentionMeta(project?: Project, task?: Task, session?: Session): string {
  return (
    [project?.name, task?.title, session && session.title !== task?.title ? session.title : null]
      .filter(Boolean)
      .join(" · ") || "Switchyard"
  );
}
