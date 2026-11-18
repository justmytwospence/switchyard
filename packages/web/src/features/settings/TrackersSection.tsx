import type { Project, TrackedIssue, Tracker } from "@switchyard/protocol";
import { CircleDot, Pencil, Plus, RefreshCw, Trash } from "lucide-react";
import { useId, useMemo, useState } from "react";
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
import { apiDelete, apiPatch, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useHosts, useSyncStore } from "../../sync/store";
import { useTrackers, useTrackersStore } from "../../sync/trackers";
import { useSelectedView } from "../views/selection";
import { KeyValues, SectionPage } from "./shared";
import {
  bodyOf,
  draftOf,
  type TrackerDraft,
  type TrackerDraftErrors,
  trackerFacts,
  validateDraft,
} from "./trackerLogic";

/** Settings › Trackers: GitHub issues and boards that feed the board. */
export function TrackersSection() {
  const { trackers, error, reload } = useTrackers();
  const [editing, setEditing] = useState<Tracker | "new" | null>(null);
  const [deleting, setDeleting] = useState<Tracker | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/api/trackers/${encodeURIComponent(deleting.id)}`);
      useTrackersStore.getState().remove(deleting.id);
      toast.success(`Tracker ${deleting.name} deleted`);
      setDeleting(null);
    } catch (e) {
      setDeleteError(e);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <SectionPage
      title="Trackers"
      description="A tracker follows the GitHub issues assigned to you, makes worktrees for their branches, and is the source of a view of its projects."
      testId="trackers-section"
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setEditing("new")}
        >
          New tracker
        </Button>
      }
    >
      {trackers === null && error ? (
        <ErrorState title="Could not load trackers" error={error} onRetry={reload} />
      ) : trackers === null ? (
        <LoadingState label="Loading trackers…" />
      ) : trackers.length === 0 ? (
        <EmptyState
          icon={<CircleDot className="size-8" />}
          title="No trackers"
          description="Add one to bring your assigned GitHub issues onto the board."
          action={{ label: "New tracker", onClick: () => setEditing("new") }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {trackers.map((t) => (
            <TrackerCard
              key={t.id}
              tracker={t}
              onEdit={() => setEditing(t)}
              onDelete={() => {
                setDeleteError(null);
                setDeleting(t);
              }}
            />
          ))}
        </div>
      )}
      <TrackerForm editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this tracker?"
        description="Its issues are removed. Its view stays, with its current projects as your own filter."
        confirmLabel="Delete tracker"
        danger
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void remove()}
      />
    </SectionPage>
  );
}

function TrackerCard({
  tracker: t,
  onEdit,
  onDelete,
}: {
  tracker: Tracker;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hosts = useSyncStore((s) => s.hosts);
  const views = useSyncStore((s) => s.views);
  const projects = useSyncStore((s) => s.projects);
  const issues = useSyncStore((s) => s.issues);
  const [, setSelectedView] = useSelectedView();
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState(false);
  const view = Object.values(views).find((v) => v.trackerId === t.id) ?? null;
  const issueCount = Object.values(issues).filter((x: TrackedIssue) => x.trackerId === t.id).length;
  const viewProjects = useMemo(
    () =>
      (view?.projectIds ?? [])
        .map((id) => projects[id])
        .filter((p): p is Project => !!p)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [view, projects],
  );

  const sync = async () => {
    setSyncing(true);
    try {
      const next = await apiPost<Tracker>(`/api/trackers/${encodeURIComponent(t.id)}/sync`, {});
      useTrackersStore.getState().upsert(next);
      if (next.lastError) toast.error(`${next.name}: ${next.lastError}`);
      else toast.success(`Synced ${next.name}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const open = (to: string) => {
    if (view) setSelectedView(view.id);
    navigate(to);
  };

  return (
    <Card
      testId={`tracker-${t.id}`}
      title={
        <span className="flex items-center gap-2">
          {t.name}
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
          <Button size="sm" variant="danger" icon={<Trash className="size-4" />} onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <KeyValues
          items={[
            ...trackerFacts(t, hosts[t.hostId]?.name ?? t.hostId),
            ["Last sync", t.lastSyncedAt ? formatRelative(t.lastSyncedAt) : "Never"],
            ["Issues", String(issueCount)],
            [
              "View",
              view ? (
                <span key="view" className="flex flex-wrap items-center gap-2">
                  {view.name}
                  <TextLink onClick={() => open(ROUTES.code)}>Sessions</TextLink>
                  <TextLink onClick={() => open(ROUTES.board)}>Board</TextLink>
                </span>
              ) : (
                "Created after the first successful sync"
              ),
            ],
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
          {viewProjects.length === 0 ? (
            <p className="text-sm text-muted">
              {t.extraRepositories?.length
                ? "No projects for this tracker here yet."
                : `No projects from ${t.owner} here yet.`}{" "}
              Add its repositories in Settings › Projects.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {viewProjects.map((p) => (
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

function TrackerForm({
  editing,
  onClose,
}: {
  editing: Tracker | "new" | null;
  onClose: () => void;
}) {
  const hosts = useHosts();
  const issues = useSyncStore((s) => s.issues);
  const defaultHost = (hosts.find((h) => h.connectivity === "connected") ?? hosts[0])?.id ?? "";
  const tracker = editing && editing !== "new" ? editing : null;
  const key = editing === null ? "closed" : (tracker?.id ?? "new");
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrackerDraft>(() => draftOf(null, defaultHost));
  const [errors, setErrors] = useState<TrackerDraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const columnsId = useId();
  if (draftKey !== key) {
    setDraftKey(key);
    setDraft(draftOf(tracker, defaultHost));
    setErrors({});
    setError(null);
  }
  const columns = useMemo(() => {
    if (!tracker) return [];
    const withBoard = Object.values(issues).find((x) => x.trackerId === tracker.id && x.board);
    return withBoard?.board?.options.map((o) => o.name) ?? [];
  }, [issues, tracker]);
  const set = <K extends keyof TrackerDraft>(k: K, v: TrackerDraft[K]) =>
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
      const saved = tracker
        ? await apiPatch<Tracker>(`/api/trackers/${encodeURIComponent(tracker.id)}`, body)
        : await apiPost<Tracker>("/api/trackers", body);
      useTrackersStore.getState().upsert(saved);
      toast.success(`Tracker ${saved.name} saved`);
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
      title={tracker ? "Edit tracker" : "New tracker"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div data-testid="tracker-form" className="flex flex-col gap-3">
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
          hint="One owner/name per line. Their projects join this tracker's view, and issues assigned to you there are tracked too."
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
          hint="A GitHub Projects board of the owner. Needs the project scope: gh auth refresh -s project."
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
            <SwitchRow
              label="Move cards on GitHub"
              description="Only cards assigned to you, only the status field, and only from the column Switchyard last saw."
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
          label="Sync this tracker"
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
