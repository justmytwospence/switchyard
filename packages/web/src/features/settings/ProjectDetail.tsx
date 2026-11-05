import type { Host, Profile, Project } from "@switchyard/protocol";
import { FolderGit2, Plus, RefreshCw, Save } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { Dialog } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { SwitchRow } from "../../components/ui/Switch";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useHosts, useSyncStore } from "../../sync/store";
import {
  InlineError,
  LastKnownNote,
  SectionPage,
  settingsPath,
  splitLines,
  useHydrated,
  validateAbsolutePath,
} from "./shared";
import { WorkspacesCard } from "./WorkspacesCard";
import { WORKTREE_DIR_HINT, worktreeDirProblem } from "./worktreeDir";

interface RefreshResponse {
  errors?: { checkoutId: string; code: string; message: string }[];
}

/** Settings › Projects › project: settings, checkouts and workspaces. */
export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const hydrated = useHydrated();
  const project = useSyncStore((s) => s.projects[projectId]);
  const hostsById = useSyncStore((s) => s.hosts);
  const profilesById = useSyncStore((s) => s.profiles);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<RefreshResponse["errors"]>([]);
  const hosts = useHosts();
  const profiles = useMemo(
    () => Object.values(profilesById).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesById],
  );

  const back = { to: settingsPath("projects"), label: "Projects" };
  if (!hydrated)
    return (
      <SectionPage title="Project" back={back}>
        <LoadingState label="Loading project…" />
      </SectionPage>
    );
  if (!project)
    return (
      <SectionPage title="Project" back={back}>
        <EmptyState
          icon={<FolderGit2 className="size-8" />}
          title="Project not found"
          description="It may have been removed, or this link is from another coordinator."
          action={{ label: "Back to projects", to: settingsPath("projects") }}
        />
      </SectionPage>
    );

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiPost<RefreshResponse>(
        `/api/projects/${encodeURIComponent(project.id)}/refresh`,
      );
      const errors = Array.isArray(res?.errors) ? res.errors : [];
      setRefreshErrors(errors);
      if (errors.length) toast.error(`Refreshed with ${errors.length} checkout error(s)`);
      else toast.success("Workspaces refreshed");
    } catch (e) {
      toast.error(`Refresh failed: ${errorMessage(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SectionPage
      title={project.name}
      description={<span className="break-all">{project.repoIdentity}</span>}
      back={back}
      actions={
        <Button busy={refreshing} icon={<RefreshCw className="size-4" />} onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <LastKnownNote />
      {refreshErrors && refreshErrors.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
        >
          <p className="font-medium">Some checkouts could not be refreshed</p>
          <ul className="list-disc pl-5">
            {refreshErrors.map((e) => (
              <li key={e.checkoutId} className="break-words">
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ProjectForm key={project.id} project={project} hosts={hosts} profiles={profiles} />
      <CheckoutsCard project={project} hosts={hosts} hostsById={hostsById} />
      <WorkspacesCard project={project} />
    </SectionPage>
  );
}

function ProjectForm({
  project,
  hosts,
  profiles,
}: {
  project: Project;
  hosts: Host[];
  profiles: Profile[];
}) {
  const ids = useId();
  const [name, setName] = useState(project.name);
  const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
  const [checks, setChecks] = useState(project.checks.join("\n"));
  const [maxRuns, setMaxRuns] = useState(String(project.maxConcurrentRuns));
  const [automationEnabled, setAutomationEnabled] = useState(project.automationEnabled);
  const [sharing, setSharing] = useState(project.workspaceSharing);
  const [profileId, setProfileId] = useState(project.defaultProfileId ?? "");
  const [hostId, setHostId] = useState(project.defaultHostId ?? "");
  const [worktreeDir, setWorktreeDir] = useState(project.worktreeDir ?? ".worktrees");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const runs = Number(maxRuns);
  const nameError = name.trim() ? null : "Enter a project name.";
  const runsError =
    Number.isInteger(runs) && runs >= 1 && runs <= 32 ? null : "Use a whole number from 1 to 32.";

  const worktreeDirError = worktreeDirProblem(worktreeDir);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (nameError || runsError || worktreeDirError) return;
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/projects/${encodeURIComponent(project.id)}`, {
        name: name.trim(),
        setupCommand: setupCommand.trim() || null,
        checks: splitLines(checks),
        maxConcurrentRuns: runs,
        automationEnabled,
        workspaceSharing: sharing,
        defaultProfileId: profileId || null,
        defaultHostId: hostId || null,
        worktreeDir: worktreeDir.trim(),
      });
      toast.success("Project settings saved");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // Keep a removed/unknown default visible instead of silently changing it.
  const hostKnown = !hostId || hosts.some((h) => h.id === hostId);
  const profileKnown = !profileId || profiles.some((p) => p.id === profileId);

  return (
    <Card title="Project settings">
      <form className="flex min-w-0 flex-col gap-4" onSubmit={save} noValidate>
        <Field id={`${ids}-name`} label="Name" error={nameError}>
          <TextInput
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...fieldControlProps(`${ids}-name`, { error: nameError })}
          />
        </Field>
        <Field
          id={`${ids}-setup`}
          label="Setup command"
          hint="Runs in each new workspace before the first session, e.g. pnpm install. Leave empty for none."
        >
          <TextInput
            id={`${ids}-setup`}
            value={setupCommand}
            onChange={(e) => setSetupCommand(e.target.value)}
            className="font-mono"
            spellCheck={false}
            autoCapitalize="off"
            {...fieldControlProps(`${ids}-setup`, { hint: true })}
          />
        </Field>
        <Field
          id={`${ids}-checks`}
          label="Checks"
          hint="One command per line. Runs must pass these before review."
        >
          <TextArea
            id={`${ids}-checks`}
            value={checks}
            minRows={3}
            onChange={(e) => setChecks(e.target.value)}
            className="font-mono"
            spellCheck={false}
            autoCapitalize="off"
            {...fieldControlProps(`${ids}-checks`, { hint: true })}
          />
        </Field>
        <Field
          id={`${ids}-runs`}
          label="Max concurrent runs"
          hint="Between 1 and 32."
          error={runsError}
        >
          <TextInput
            id={`${ids}-runs`}
            type="number"
            inputMode="numeric"
            min={1}
            max={32}
            step={1}
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
            className="max-w-32"
            {...fieldControlProps(`${ids}-runs`, { hint: true, error: runsError })}
          />
        </Field>
        <Field
          id={`${ids}-worktree`}
          label="Worktree folder"
          hint={WORKTREE_DIR_HINT}
          error={worktreeDirError}
        >
          <TextInput
            id={`${ids}-worktree`}
            data-testid="project-worktree-dir"
            value={worktreeDir}
            onChange={(e) => setWorktreeDir(e.target.value)}
            placeholder=".worktrees"
            className="font-mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            {...fieldControlProps(`${ids}-worktree`, { hint: true, error: worktreeDirError })}
          />
        </Field>
        <SwitchRow
          label="Automation"
          description="When off, ready tasks in this project wait instead of starting automatically."
          checked={automationEnabled}
          onChange={setAutomationEnabled}
        />
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Workspace sharing</legend>
          {(
            [
              [
                "single_writer",
                "Single writer",
                "Only one run or session writes in a workspace at a time; others wait. Safest.",
              ],
              [
                "shared",
                "Shared",
                "Several sessions may write in the same workspace at once. Their changes can interleave.",
              ],
            ] as const
          ).map(([value, label, help]) => (
            <div key={value} className="flex items-start gap-2">
              <input
                id={`${ids}-sharing-${value}`}
                type="radio"
                name={`${ids}-sharing`}
                value={value}
                checked={sharing === value}
                onChange={() => setSharing(value)}
                aria-describedby={`${ids}-sharing-${value}-desc`}
                className="tap mt-0.5 size-5 shrink-0 accent-[var(--sy-accent)]"
              />
              <label htmlFor={`${ids}-sharing-${value}`} className="min-w-0 text-sm">
                <span className="block font-medium">{label}</span>
                <span id={`${ids}-sharing-${value}-desc`} className="block text-muted">
                  {help}
                </span>
              </label>
            </div>
          ))}
        </fieldset>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id={`${ids}-profile`} label="Default Pi profile">
            <Select
              id={`${ids}-profile`}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">None (use the coordinator default)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {!profileKnown && <option value={profileId}>Unknown profile ({profileId})</option>}
            </Select>
          </Field>
          <Field
            id={`${ids}-host`}
            label="Default host"
            hint="Runs start here when the task does not choose a host."
          >
            <Select
              id={`${ids}-host`}
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              {...fieldControlProps(`${ids}-host`, { hint: true })}
            >
              <option value="">None (any host with a checkout)</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.connectivity === "connected" ? "" : ` (${h.connectivity})`}
                </option>
              ))}
              {!hostKnown && <option value={hostId}>Unknown host ({hostId})</option>}
            </Select>
          </Field>
        </div>
        <InlineError error={error} />
        <div>
          <Button type="submit" variant="primary" busy={busy} icon={<Save className="size-4" />}>
            Save project
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CheckoutsCard({
  project,
  hosts,
  hostsById,
}: {
  project: Project;
  hosts: Host[];
  hostsById: Record<string, Host>;
}) {
  const checkoutsById = useSyncStore((s) => s.checkouts);
  const checkouts = useMemo(
    () =>
      Object.values(checkoutsById)
        .filter((c) => c.projectId === project.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [checkoutsById, project.id],
  );
  const [adding, setAdding] = useState(false);
  return (
    <Card
      title="Checkouts"
      description="Clones of this repository. Add one per host that should run this project."
      actions={
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Add checkout
        </Button>
      }
    >
      {checkouts.length === 0 ? (
        <EmptyState
          className="py-4"
          title="No checkouts"
          description="Add a checkout so sessions and runs have somewhere to work."
          action={{ label: "Add checkout", onClick: () => setAdding(true) }}
        />
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {checkouts.map((c) => {
            const host = hostsById[c.hostId];
            return (
              <li key={c.id} className="min-w-0 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{host?.name ?? "Unknown host"}</span>
                  {host && host.connectivity !== "connected" && (
                    <span className="text-xs text-muted">({host.connectivity})</span>
                  )}
                </div>
                <div className="break-all font-mono text-xs">{c.path}</div>
                <div className="text-xs text-muted">Default branch: {c.defaultBranch}</div>
              </li>
            );
          })}
        </ul>
      )}
      <AddCheckoutDialog
        open={adding}
        onClose={() => setAdding(false)}
        project={project}
        hosts={hosts}
      />
    </Card>
  );
}

function AddCheckoutDialog({
  open,
  onClose,
  project,
  hosts,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  hosts: Host[];
}) {
  const ids = useId();
  const connected = hosts.filter((h) => h.connectivity === "connected");
  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const effectiveHost = hostId || connected[0]?.id || "";
  const pathError = submitted || path ? validateAbsolutePath(path) : null;

  const close = () => {
    if (busy) return;
    setSubmitted(false);
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!effectiveHost || validateAbsolutePath(path)) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${encodeURIComponent(project.id)}/checkouts`, {
        hostId: effectiveHost,
        path: path.trim(),
      });
      toast.success("Checkout added");
      setPath("");
      setSubmitted(false);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const formId = `${ids}-form`;
  return (
    <Dialog
      open={open}
      onClose={close}
      dismissOnBackdrop={!busy}
      title="Add checkout"
      description={`Another clone of ${project.repoIdentity}.`}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={busy}
            disabled={connected.length === 0}
          >
            Add checkout
          </Button>
        </>
      }
    >
      <form id={formId} className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
        {connected.length === 0 && (
          <p className="text-sm text-muted">
            No host is connected. The checkout is inspected on its host, so the host must be online.
          </p>
        )}
        <Field id={`${ids}-host`} label="Host" hint="Only connected hosts are listed.">
          <Select
            id={`${ids}-host`}
            value={effectiveHost}
            onChange={(e) => setHostId(e.target.value)}
            disabled={connected.length === 0}
            {...fieldControlProps(`${ids}-host`, { hint: true })}
          >
            {connected.length === 0 && <option value="">No connected hosts</option>}
            {connected.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id={`${ids}-path`}
          label="Checkout path on the host"
          hint="Absolute path of an existing clone of this repository."
          error={pathError}
        >
          <TextInput
            id={`${ids}-path`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/me/src/app"
            className="font-mono"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            {...fieldControlProps(`${ids}-path`, { hint: true, error: pathError })}
          />
        </Field>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
