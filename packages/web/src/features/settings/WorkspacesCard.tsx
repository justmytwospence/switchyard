import type { Project, Workspace } from "@switchyard/protocol";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Trash,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { EmptyState } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { apiPost, errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { Card, ConfirmDialog, InlineStatus } from "./shared";

const PROVENANCE_LABEL: Record<Workspace["provenance"], string> = {
  managed: "Managed by Switchyard",
  discovered: "Discovered worktree",
  main: "Main checkout",
};

const SETUP_STATUS = {
  none: { icon: CircleDashed, label: "No setup", tone: "neutral" },
  running: { icon: LoaderCircle, label: "Setup running", tone: "info" },
  succeeded: { icon: CircleCheck, label: "Setup succeeded", tone: "success" },
  failed: { icon: CircleX, label: "Setup failed", tone: "danger" },
} as const;

/** Git status as text (never color alone). */
export function gitSummary(git: Workspace["git"]): string {
  const parts = [
    git.dirty
      ? `Uncommitted changes (${git.changedFiles} file${git.changedFiles === 1 ? "" : "s"})`
      : "Clean",
  ];
  if (git.ahead || git.behind) parts.push(`${git.ahead} ahead, ${git.behind} behind`);
  parts.push(git.unmerged ? "Not merged into base" : "Merged");
  return parts.join(" · ");
}

/** Workspaces of a project (live from the store) with refresh and guarded removal. */
export function WorkspacesCard({ project }: { project: Project }) {
  const workspacesById = useSyncStore((s) => s.workspaces);
  const hosts = useSyncStore((s) => s.hosts);
  const workspaces = useMemo(
    () =>
      Object.values(workspacesById)
        .filter((w) => w.projectId === project.id && w.archivedAt === null)
        .sort(
          (a, b) =>
            Number(b.provenance === "main") - Number(a.provenance === "main") ||
            (a.branch ?? "").localeCompare(b.branch ?? ""),
        ),
    [workspacesById, project.id],
  );
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const refresh = async (w: Workspace) => {
    setRefreshing(w.id);
    try {
      await apiPost(`/api/workspaces/${encodeURIComponent(w.id)}/refresh`);
      toast.success("Workspace status refreshed");
    } catch (e) {
      toast.error(`Could not refresh: ${errorMessage(e)}`);
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <Card
      title="Workspaces"
      description="Worktrees where sessions and runs work. Removing one never deletes its branch."
    >
      {workspaces.length === 0 ? (
        <EmptyState
          className="py-4"
          title="No workspaces"
          description="Workspaces appear after a checkout is discovered. Use Refresh to discover them again."
        />
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {workspaces.map((w) => {
            const host = hosts[w.hostId];
            const offline = host?.connectivity !== "connected";
            const setup = SETUP_STATUS[w.setup.state] ?? SETUP_STATUS.none;
            return (
              <li key={w.id} className="flex min-w-0 flex-col gap-1.5 py-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <GitBranch aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 break-all font-mono font-medium">
                    {w.branch ?? "(detached HEAD)"}
                  </span>
                  <span className="text-xs text-muted">{PROVENANCE_LABEL[w.provenance]}</span>
                </div>
                <div className="break-all font-mono text-xs text-muted">
                  {host?.name ? `${host.name}: ` : ""}
                  {w.path}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span>{gitSummary(w.git)}</span>
                  <InlineStatus
                    icon={setup.icon}
                    label={setup.label}
                    tone={setup.tone}
                    spin={w.setup.state === "running"}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    icon={<RefreshCw className="size-4" />}
                    busy={refreshing === w.id}
                    disabled={offline}
                    onClick={() => refresh(w)}
                  >
                    Refresh status
                  </Button>
                  {w.provenance !== "main" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      icon={<Trash className="size-4" />}
                      disabled={offline}
                      onClick={() => setRemoving(w)}
                    >
                      Remove
                    </Button>
                  )}
                  {w.provenance === "main" && (
                    <span className="text-xs text-muted">
                      The main checkout cannot be removed; remove the project's checkout instead.
                    </span>
                  )}
                  {offline && (
                    <span className="text-xs text-muted">
                      Host {host?.name ?? "unknown"} is {host?.connectivity ?? "unknown"}: refresh
                      and removal need it online.
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <RemoveWorkspaceDialog
          key={removing.id}
          workspace={workspacesById[removing.id] ?? removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}

/**
 * Confirm removal. Dirty or unmerged workspaces need explicit checkboxes that
 * become the force flags; a 409 from the server reveals the matching checkbox.
 * No optimistic success: busy until the response, then a toast.
 */
function RemoveWorkspaceDialog({
  workspace: w,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [needDirty, setNeedDirty] = useState(w.git.dirty);
  const [needUnmerged, setNeedUnmerged] = useState(w.git.unmerged);
  const [forceDirty, setForceDirty] = useState(false);
  const [forceUnmerged, setForceUnmerged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const missing = (needDirty && !forceDirty) || (needUnmerged && !forceUnmerged);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/workspaces/${encodeURIComponent(w.id)}/remove`, {
        force: { dirty: forceDirty, unmerged: forceUnmerged },
      });
      toast.success(`Workspace ${w.branch ?? w.path} removed`);
      onClose();
    } catch (e) {
      if (isApiError(e, "workspace_dirty")) setNeedDirty(true);
      if (isApiError(e, "workspace_unmerged")) setNeedUnmerged(true);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Remove workspace?"
      description={<span className="break-all font-mono">{w.branch ?? w.path}</span>}
      confirmLabel="Remove workspace"
      busy={busy}
      error={error}
      onConfirm={remove}
      confirmDisabled={missing}
      disabledReason="Check the boxes above to confirm what will be lost."
    >
      <p className="text-sm">
        The worktree at <span className="break-all font-mono">{w.path}</span> is deleted from the
        host. The branch is kept.
      </p>
      {needDirty && (
        <Checkbox
          label="Discard uncommitted changes"
          description={
            w.git.dirty
              ? `${w.git.changedFiles} changed file${w.git.changedFiles === 1 ? "" : "s"} will be lost.`
              : "The host reported uncommitted changes; they will be lost."
          }
          checked={forceDirty}
          onChange={setForceDirty}
        />
      )}
      {needUnmerged && (
        <Checkbox
          label="Remove although the branch is not merged"
          description="Commits stay on the branch, but the workspace is gone."
          checked={forceUnmerged}
          onChange={setForceUnmerged}
        />
      )}
    </ConfirmDialog>
  );
}
