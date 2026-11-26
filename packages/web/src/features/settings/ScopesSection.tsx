import type { Project, Scope, TrackedIssue } from "@switchyard/protocol";
import { hasSource } from "@switchyard/protocol";
import { CircleDot, Pencil, Plus, RefreshCw, Trash } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ROUTES } from "../../app/routes";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { Switch } from "../../components/ui/Switch";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { shownIn } from "../scopes/describe";
import { sourceFacts } from "../scopes/githubSourceLogic";
import { ScopeDialog } from "../scopes/ScopeDialog";
import { useScopeDescriber } from "../scopes/ScopeSelect";
import { useSelectedScope } from "../scopes/selection";
import { KeyValues, SectionPage, useHydrated } from "./shared";

/** When each scope last synced, by scope id (null: never). */
type SyncTimes = Record<string, string | null>;

/**
 * A sync that changes nothing but its time publishes no event, so the synced scopes can show a
 * stale "Last sync". Read the times over REST when the page opens, and after Sync now.
 */
function useSyncTimes(): { times: SyncTimes; note: (s: Scope) => void } {
  const [times, setTimes] = useState<SyncTimes>({});
  const note = useCallback((s: Scope) => {
    if (s.source) setTimes((t) => ({ ...t, [s.id]: s.source!.lastSyncedAt }));
  }, []);
  useEffect(() => {
    let live = true;
    apiGet<Scope[]>("/api/scopes")
      .then((list) => {
        if (!live) return;
        setTimes(
          Object.fromEntries(
            list.filter(hasSource).map((s) => [s.id, s.source.lastSyncedAt] as const),
          ),
        );
      })
      .catch(() => {
        // The synced scopes still show their last known time.
      });
    return () => {
      live = false;
    };
  }, []);
  return { times, note };
}

/** Settings › Scopes: named parts of your work, and the GitHub issues that feed them. */
export function ScopesSection() {
  const hydrated = useHydrated();
  const byId = useSyncStore((s) => s.scopes);
  const scopes = useMemo(() => Object.values(byId), [byId]);
  const { times, note } = useSyncTimes();
  /** The scope dialog: a scope id, "new", or closed. */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/api/scopes/${encodeURIComponent(deleting.id)}`);
      toast.success(`Scope ${deleting.name} deleted`);
      setDeleting(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const ask = (set: (s: Scope) => void) => (s: Scope) => {
    setError(null);
    set(s);
  };

  return (
    <SectionPage
      title="Scopes"
      description="A scope is a named part of your work. Sessions and the Board can show one, and a herdr or tmux session can mirror one."
      testId="scopes-section"
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setEditing("new")}
        >
          New scope
        </Button>
      }
    >
      {!hydrated ? (
        <LoadingState label="Loading scopes…" />
      ) : scopes.length === 0 ? (
        <EmptyState
          icon={<CircleDot className="size-8" />}
          title="No scopes"
          description="Add one to group your work, or to bring your GitHub issues onto the Board."
          action={{ label: "New scope", onClick: () => setEditing("new") }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {scopes.map((s) => (
            <ScopeCard
              key={s.id}
              scope={s}
              lastSyncedAt={s.id in times ? times[s.id]! : (s.source?.lastSyncedAt ?? null)}
              onSynced={note}
              onEdit={() => setEditing(s.id)}
              onDelete={() => ask(setDeleting)(s)}
            />
          ))}
        </div>
      )}
      <ScopeDialog editing={editing} onClose={() => setEditing(null)} onSaved={() => {}} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this scope?"
        description={`Sessions are not affected. Clients mirroring it then mirror nothing and keep their tabs.${deleting?.source ? " Its issues are removed from the Board." : ""}`}
        confirmLabel="Delete scope"
        danger
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
      />
    </SectionPage>
  );
}

/** Links that select the scope and open Sessions or the Board. */
function OpenLinks({ scope }: { scope: Scope }) {
  const [, setSelectedScope] = useSelectedScope();
  const navigate = useNavigate();
  const open = (to: string) => {
    setSelectedScope(scope.id);
    navigate(to);
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <TextLink onClick={() => open(ROUTES.code)}>Sessions</TextLink>
      <TextLink onClick={() => open(ROUTES.board)}>Board</TextLink>
    </span>
  );
}

/** One scope: what it contains, its GitHub source and sync state if it has one, and where it is mirrored. */
function ScopeCard({
  scope,
  lastSyncedAt,
  onSynced,
  onEdit,
  onDelete,
}: {
  scope: Scope;
  lastSyncedAt: string | null;
  onSynced: (s: Scope) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = scope.source;
  const { describe } = useScopeDescriber();
  const hosts = useSyncStore((s) => s.hosts);
  const clients = useSyncStore((s) => s.clients);
  const projects = useSyncStore((s) => s.projects);
  const issues = useSyncStore((s) => s.issues);
  const [syncing, setSyncing] = useState(false);
  const issueCount = Object.values(issues).filter(
    (x: TrackedIssue) => x.scopeId === scope.id,
  ).length;
  const scopeProjects = useMemo(
    () =>
      (scope.projectIds ?? [])
        .map((id) => projects[id])
        .filter((p): p is Project => !!p)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [scope, projects],
  );
  const pinned = scope.sessionIds.length;

  const sync = async () => {
    setSyncing(true);
    try {
      const next = await apiPost<Scope>(`/api/scopes/${encodeURIComponent(scope.id)}/sync`, {});
      onSynced(next);
      if (next.source?.lastError) toast.error(`${next.name}: ${next.source.lastError}`);
      else toast.success(`Synced ${next.name}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card
      testId={`scope-${scope.id}`}
      title={
        <span className="flex items-center gap-2">
          {scope.name}
          {t && <Badge tone="neutral">GitHub</Badge>}
          {t && !t.enabled && <Badge tone="neutral">Paused</Badge>}
        </span>
      }
      actions={
        <>
          {t && (
            <Button
              size="sm"
              icon={<RefreshCw className="size-4" />}
              busy={syncing}
              onClick={() => void sync()}
            >
              Sync now
            </Button>
          )}
          <Button size="sm" icon={<Pencil className="size-4" />} onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            icon={<Trash className="size-4" />}
            onClick={onDelete}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <KeyValues
          items={[
            ["Contains", describe(scope)],
            ...(t ? sourceFacts(t, hosts[t.hostId]?.name ?? t.hostId) : []),
            ...(t
              ? ([
                  [
                    "Last sync",
                    `${lastSyncedAt ? formatRelative(lastSyncedAt) : "Never"} · ${issueCount} issue${issueCount === 1 ? "" : "s"}`,
                  ],
                ] as [string, string][])
              : []),
            ...(scope.mode === "pinned" || pinned > 0
              ? ([["Pinned", `${pinned} session${pinned === 1 ? "" : "s"}`]] as [string, string][])
              : []),
            ["Mirrored in", shownIn(scope, Object.values(clients), hosts) ?? "No client"],
            ["Open", <OpenLinks key="open" scope={scope} />],
          ]}
        />
        {t?.lastError && (
          <p
            role="status"
            className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm break-words"
          >
            {t.lastError}
          </p>
        )}
        {t && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Projects</h3>
            {scopeProjects.length === 0 ? (
              <p className="text-sm text-muted">
                {t.extraRepositories?.length
                  ? "No projects for this scope here yet."
                  : `No projects from ${t.owner} here yet.`}{" "}
                Add its repositories in Settings › Projects.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {scopeProjects.map((p) => (
                  <ProjectRules key={p.id} project={p} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** A project's worktree rules, as in Settings › Projects. */
function ProjectRules({ project }: { project: Project }) {
  const [busy, setBusy] = useState<"ensureSessions" | "removeLanded" | null>(null);
  const toggle = async (key: "ensureSessions" | "removeLanded", value: boolean) => {
    setBusy(key);
    try {
      await apiPatch(`/api/projects/${encodeURIComponent(project.id)}`, { [key]: value });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 py-2">
      <Link
        to={ROUTES.settings(`projects/${project.id}`)}
        className="min-w-0 flex-[1_1_10rem] truncate text-sm font-medium text-accent hover:underline"
      >
        {project.name}
      </Link>
      <Switch
        label={`Keep a session in every worktree of ${project.name}`}
        onText="Session per worktree"
        offText="Session per worktree"
        checked={project.ensureSessions ?? false}
        busy={busy === "ensureSessions"}
        onChange={(v) => void toggle("ensureSessions", v)}
      />
      <Switch
        label={`Remove merged worktrees of ${project.name}`}
        onText="Remove merged"
        offText="Remove merged"
        checked={project.removeLanded ?? false}
        busy={busy === "removeLanded"}
        onChange={(v) => void toggle("removeLanded", v)}
      />
    </li>
  );
}
