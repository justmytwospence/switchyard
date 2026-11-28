import { Play } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import type { IssueInventoryItem } from "./model";

interface IssueListProps {
  items: IssueInventoryItem[];
  selectedId: string | null;
  onInspect: (id: string) => void;
  onAction?: (id: string) => void;
  pending?: boolean;
  showRepo?: boolean;
  actionLabel?: (item: IssueInventoryItem) => string;
  actionDetail?: (item: IssueInventoryItem) => string;
  actionProblem?: (item: IssueInventoryItem) => string | null;
  label?: string;
}

function focusRow(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (!(event.target instanceof HTMLElement)) return;
  const row = event.target.closest("li");
  if (!row || row.parentElement !== event.currentTarget) return;
  const next = event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
  const nextTitle = next?.querySelector<HTMLButtonElement>("button[data-issue-title]");
  if (nextTitle) {
    event.preventDefault();
    event.stopPropagation();
    nextTitle.focus();
  }
}

/** Issues can be inspected without starting work, even inside a launcher form. */
export function IssueList({
  items,
  selectedId,
  onInspect,
  onAction,
  pending,
  showRepo = true,
  actionLabel,
  actionDetail,
  actionProblem,
  label = "Tracked issues",
}: IssueListProps) {
  return (
    <ul aria-label={label} className="min-w-0 divide-y divide-border" onKeyDown={focusRow}>
      {items.map((item) => {
        const { id, issue, sessionId, branchName } = item;
        const problem = actionProblem?.(item);
        const action = actionLabel?.(item) ?? (sessionId ? "Open session" : "Start session");
        const selectable = onAction && (sessionId || !item.merged);
        const metadata = [
          showRepo && issue.repository,
          issue.board?.status,
          issue.assignees.length ? issue.assignees.join(", ") : "Unassigned",
          issue.board?.priority && `Priority: ${issue.board.priority.name}`,
          issue.parent && `Part of #${issue.parent.number}`,
          item.showOrigin && item.origin,
          item.merged
            ? "Merged"
            : sessionId
              ? "Session exists"
              : branchName &&
                (item.placement
                  ? `Branch: ${branchName}`
                  : `Linked branch · no worktree yet · ${branchName}`),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <li
            key={id}
            data-issue-id={id}
            className={cn(
              "flex flex-wrap items-start justify-between gap-2 px-2 py-2.5",
              selectedId === id && "bg-surface-2",
            )}
          >
            <div className="min-w-0 flex-1 basis-60">
              <button
                type="button"
                data-issue-title
                aria-pressed={selectedId === id}
                onClick={() => onInspect(id)}
                className="block w-full break-words rounded text-left text-sm font-medium hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="text-muted tabular-nums">#{issue.number}</span> {issue.title}
              </button>
              <p className="mt-0.5 break-words text-xs text-muted">{metadata}</p>
            </div>
            {selectable && (
              <div className="max-w-full text-right">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Play className="size-3.5" />}
                  disabled={pending || !!problem}
                  onClick={() => onAction(id)}
                  aria-label={`${action} for #${issue.number} ${issue.title}`}
                >
                  {action}
                </Button>
                {(problem || actionDetail) && !sessionId && (
                  <p className="mt-1 max-w-60 break-words text-xs text-muted">
                    {problem ?? actionDetail?.(item)}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
