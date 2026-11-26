import type { GitHubScope, Project, Scope, TrackedIssue } from "@switchyard/protocol";
import { hasSource } from "@switchyard/protocol";
import { CircleDot, Pencil, Plus, RefreshCw, Trash, Unplug } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ROUTES } from "../../app/routes";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { Switch, SwitchRow } from "../../components/ui/Switch";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useHosts, useSyncStore } from "../../sync/store";
import { ScopeDialog } from "../code/ScopeDialog";
import { shownIn } from "../scopes/describe";
import { useScopeDescriber } from "../scopes/ScopeSelect";
import { useSelectedScope } from "../scopes/selection";
import {
  bodyOf,
  draftOf,
  type GitHubSourceDraft,
  type GitHubSourceDraftErrors,
  sourceFacts,
  validateDraft,
} from "./githubSourceLogic";
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
  /** The GitHub form: a scope (to edit or connect), "new", or closed. */
  const [github, setGithub] = useState<Scope | "new" | null>(null);
  const [deleting, setDeleting] = useState<Scope | null>(null);
  const [disconnecting, setDisconnecting] = useState<Scope | null>(null);
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

  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/scopes/${encodeURIComponent(disconnecting.id)}`, { source: null });
      toast.success(`GitHub disconnected from ${disconnecting.name}`);
      setDisconnecting(null);
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
      description="A scope is a named part of your work: projects you choose and sessions you pin, or the GitHub issues assigned to you or on a Projects board. Sessions and the Board can show one scope, and a herdr or tmux client can mirror one."
      testId="scopes-section"
      actions={
        <>
          <Button icon={<CircleDot className="size-4" />} onClick={() => setGithub("new")}>
            New GitHub scope
          </Button>
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setEditing("new")}
          >
            New scope
          </Button>
        </>
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
          {scopes.map((s) =>
            hasSource(s) ? (
              <GitHubScopeCard
                key={s.id}
                scope={s}
                lastSyncedAt={s.id in times ? times[s.id]! : s.source.lastSyncedAt}
                onSynced={note}
                onEdit={() => setGithub(s)}
                onDisconnect={() => ask(setDisconnecting)(s)}
                onDelete={() => ask(setDeleting)(s)}
              />
            ) : (
              <ManualScopeCard
                key={s.id}
                scope={s}
                onConnect={() => setGithub(s)}
                onEdit={() => setEditing(s.id)}
                onDelete={() => ask(setDeleting)(s)}
              />
            ),
          )}
        </div>
      )}
      <ScopeDialog editing={editing} onClose={() => setEditing(null)} onSaved={() => {}} />
      <GitHubSourceForm editing={github} onClose={() => setGithub(null)} />
      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        title="Disconnect GitHub from this scope?"
        description="Its issues are removed from the Board. The scope stays, with its current projects as your own filter."
        confirmLabel="Disconnect GitHub"
        danger
        busy={busy}
        error={error}
        onConfirm={() => void disconnect()}
      />
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

/** A scope of projects you choose and sessions you pin. */
function ManualScopeCard({
  scope,
  onConnect,
  onEdit,
  onDelete,
}: {
  scope: Scope;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { describe } = useScopeDescriber();
  const clients = useSyncStore((s) => s.clients);
  const hosts = useSyncStore((s) => s.hosts);
  return (
    <Card
      testId={`scope-${scope.id}`}
      title={scope.name}
      actions={
        <>
          <Button size="sm" icon={<CircleDot className="size-4" />} onClick={onConnect}>
            Connect GitHub
          </Button>
          <Button size="sm" icon={<Pencil className="size-4" />} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="danger" icon={<Trash className="size-4" />} onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <KeyValues
        items={[
          ["Contains", describe(scope)],
          ["Pinned", String(scope.sessionIds.length)],
          ["Mirrored in", shownIn(scope, Object.values(clients), hosts) ?? "No client"],
          ["Open", <OpenLinks key="open" scope={scope} />],
        ]}
      />
    </Card>
  );
}

/** A scope fed by GitHub: its source, sync state, issues and projects. */
function GitHubScopeCard({
  scope,
  lastSyncedAt,
  onSynced,
  onEdit,
  onDisconnect,
  onDelete,
}: {
  scope: GitHubScope;
  lastSyncedAt: string | null;
  onSynced: (s: Scope) => void;
  onEdit: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  const t = scope.source;
  const hosts = useSyncStore((s) => s.hosts);
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
          <Badge tone="neutral">GitHub</Badge>
          {!t.enabled && <Badge tone="neutral">Paused</Badge>}
        </span>
      }
      actions={
        <>
          <Button
            size="sm"
            icon={<RefreshCw className="size-4" />}
            busy={syncing}
            onClick={() => void sync()}
          >
            Sync now
          </Button>
          <Button size="sm" icon={<Pencil className="size-4" />} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" icon={<Unplug className="size-4" />} onClick={onDisconnect}>
            Disconnect GitHub
          </Button>
          <Button size="sm" variant="danger" icon={<Trash className="size-4" />} onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <KeyValues
          items={[
            ...sourceFacts(t, hosts[t.hostId]?.name ?? t.hostId),
            ["Last sync", lastSyncedAt ? formatRelative(lastSyncedAt) : "Never"],
            ["Issues", String(issueCount)],
            ["Open", <OpenLinks key="open" scope={scope} />],
          ]}
        />
        {t.lastError && (
          <p
            role="status"
            className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm break-words"
          >
            {t.lastError}
          </p>
        )}
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

function GitHubSourceForm({
  editing,
  onClose,
}: {
  /** A scope to edit (or, without a source, to connect), "new", or null (closed). */
  editing: Scope | "new" | null;
  onClose: () => void;
}) {
  const hosts = useHosts();
  const issues = useSyncStore((s) => s.issues);
  const defaultHost = (hosts.find((h) => h.connectivity === "connected") ?? hosts[0])?.id ?? "";
  const scope = editing && editing !== "new" ? editing : null;
  const key = editing === null ? "closed" : (scope?.id ?? "new");
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<GitHubSourceDraft>(() => draftOf(null, defaultHost));
  const [errors, setErrors] = useState<GitHubSourceDraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const columnsId = useId();
  if (draftKey !== key) {
    setDraftKey(key);
    setDraft(draftOf(scope, defaultHost));
    setErrors({});
    setError(null);
  }
  const columns = useMemo(() => {
    if (!scope) return [];
    const withBoard = Object.values(issues).find((x) => x.scopeId === scope.id && x.board);
    return withBoard?.board?.options.map((o) => o.name) ?? [];
  }, [issues, scope]);
  const set = <K extends keyof GitHubSourceDraft>(k: K, v: GitHubSourceDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const hasBoard = draft.board.trim() !== "";

  const save = async () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body = bodyOf(draft);
      const saved = scope
        ? await apiPatch<Scope>(`/api/scopes/${encodeURIComponent(scope.id)}`, body)
        : await apiPost<Scope>("/api/scopes", body);
      toast.success(`Scope ${saved.name} saved`);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const conflict = isApiError(error, "conflict") ? errorMessage(error) : null;
  return (
    <Dialog
      open={editing !== null}
      onClose={onClose}
      title={!scope ? "New GitHub scope" : scope.source ? "Edit GitHub scope" : "Connect GitHub"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div data-testid="github-source-form" className="flex flex-col gap-3">
        <Field label="Name" error={errors.name ?? conflict}>
          {(p) => (
            <TextInput
              {...p}
              value={draft.name}
              maxLength={60}
              onChange={(e) => set("name", e.target.value)}
            />
          )}
        </Field>
        <Field label="Host" hint="Its gh login reads your issues." error={errors.hostId}>
          {(p) => (
            <Select {...p} value={draft.hostId} onChange={(e) => set("hostId", e.target.value)}>
              <option value="">Choose a host</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="GitHub owner"
          hint="An organization or user, such as fieldgoalco."
          error={errors.owner}
        >
          {(p) => (
            <TextInput
              {...p}
              value={draft.owner}
              spellCheck={false}
              onChange={(e) => set("owner", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Repositories"
          optional
          hint="One owner/name per line. Leave empty for every repository of the owner."
          error={errors.repositories}
        >
          {(p) => (
            <TextArea
              {...p}
              rows={3}
              value={draft.repositories}
              spellCheck={false}
              onChange={(e) => set("repositories", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Repositories of other owners"
          optional
          hint="One owner/name per line. Their projects join this scope, and issues assigned to you there are tracked too."
          error={errors.extraRepositories}
        >
          {(p) => (
            <TextArea
              {...p}
              rows={2}
              value={draft.extraRepositories}
              spellCheck={false}
              onChange={(e) => set("extraRepositories", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Board number"
          optional
          hint="A GitHub Projects board of the owner. Needs the project permission on your gh login: gh auth refresh -s project."
          error={errors.board}
        >
          {(p) => (
            <TextInput
              {...p}
              inputMode="numeric"
              value={draft.board}
              onChange={(e) => set("board", e.target.value)}
            />
          )}
        </Field>
        {hasBoard && (
          <>
            <datalist id={columnsId}>
              {columns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <Field label="Issues to follow" hint="On the board, issues need no assignee.">
              {(p) => (
                <Select
                  {...p}
                  value={draft.follow}
                  onChange={(e) => set("follow", e.target.value as GitHubSourceDraft["follow"])}
                >
                  <option value="assigned">Assigned to me</option>
                  <option value="board">Every open issue on the board</option>
                </Select>
              )}
            </Field>
            <Field label="Status field">
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.statusField}
                  onChange={(e) => set("statusField", e.target.value)}
                />
              )}
            </Field>
            <Field label="Column when work starts" optional>
              {(p) => (
                <TextInput
                  {...p}
                  list={columnsId}
                  value={draft.onStart}
                  onChange={(e) => set("onStart", e.target.value)}
                />
              )}
            </Field>
            <Field label="Column when a pull request opens" optional>
              {(p) => (
                <TextInput
                  {...p}
                  list={columnsId}
                  value={draft.onReview}
                  onChange={(e) => set("onReview", e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Backlog columns"
              optional
              hint="Cards in these columns are not tracked until they have a branch or pull request. Separate names with commas."
              error={errors.backlog}
            >
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.backlog}
                  onChange={(e) => set("backlog", e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Priority field"
              optional
              hint="A single-select field, such as Priority. Not-started issues are listed by it."
            >
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.priorityField}
                  onChange={(e) => set("priorityField", e.target.value)}
                />
              )}
            </Field>
            <SwitchRow
              label="Move cards on GitHub"
              description={
                draft.follow === "board"
                  ? "Cards assigned to you or to nobody, only the status field, and only from the column Switchyard last saw."
                  : "Only cards assigned to you, only the status field, and only from the column Switchyard last saw."
              }
              checked={draft.writeBack}
              onChange={(v) => set("writeBack", v)}
            />
            {draft.writeBack && (
              <SwitchRow
                label="Also move cards assigned to others too"
                checked={draft.moveShared}
                onChange={(v) => set("moveShared", v)}
              />
            )}
          </>
        )}
        <SwitchRow
          label="Make worktrees for issue branches"
          description="Off: Switchyard only links the worktrees you make and never creates one."
          checked={draft.worktrees}
          onChange={(v) => set("worktrees", v)}
        />
        <SwitchRow
          label="Sync this scope"
          checked={draft.enabled}
          onChange={(v) => set("enabled", v)}
        />
        {error !== null && !conflict && (
          <ErrorState compact title="Could not save" error={errorMessage(error)} />
        )}
      </div>
    </Dialog>
  );
}
