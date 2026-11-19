import {
  issueLinkProblem,
  issueLookup,
  issueUnlinkProblem,
  type TrackedIssue,
  type Workspace,
} from "@switchyard/protocol";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { linkIssue } from "./api";

/** A workspace's issue, the issues it could be linked to, and whether its link can be undone here. */
export function useIssueLink(workspace: Workspace | null | undefined): {
  linked: TrackedIssue | null;
  candidates: TrackedIssue[];
  canUnlink: boolean;
} {
  const issues = useSyncStore((s) => s.issues);
  return useMemo(() => {
    const list = Object.values(issues);
    const linked = workspace ? issueLookup(list)(workspace) : null;
    const candidates =
      workspace && !linked
        ? list
            .filter((i) => issueLinkProblem(i, workspace, list) === null)
            .sort((a, b) => a.number - b.number)
        : [];
    return { linked, candidates, canUnlink: !!linked && issueUnlinkProblem(linked) === null };
  }, [issues, workspace]);
}

/** Pick a not-started issue to link a worktree's branch to. */
export function LinkIssueDialog({
  open,
  onClose,
  workspace,
  candidates,
}: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  candidates: TrackedIssue[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  const pick = async (issue: TrackedIssue) => {
    if (busy) return;
    setBusy(issue.id);
    setError(null);
    try {
      await linkIssue(issue.id, workspace.id);
      toast.success(`Linked to #${issue.number}`);
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Link to issue"
      description={`Link ${workspace.branch} to an issue that has no branch yet. Its sessions then stay in the tracker's view.`}
      footer={<Button onClick={close}>Cancel</Button>}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {error !== null && (
          <ErrorState compact title="Could not link" error={errorMessage(error)} />
        )}
        {candidates.length === 0 && (
          <p className="text-sm text-muted">No issue without a branch in this project.</p>
        )}
        <ul className="flex min-w-0 flex-col gap-1">
          {candidates.map((i) => (
            <li key={i.id} className="min-w-0">
              <button
                type="button"
                disabled={!!busy}
                aria-busy={busy === i.id}
                onClick={() => void pick(i)}
                className="tap flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-55"
              >
                <span className="truncate text-sm">
                  #{i.number} {i.title}
                </span>
                <span className="truncate text-xs text-muted">{i.repository}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
