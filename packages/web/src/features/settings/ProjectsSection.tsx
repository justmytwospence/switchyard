import type { Project } from "@switchyard/protocol";
import { ChevronRight, FolderGit2, FolderPlus, Plus } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, buttonClasses } from "../../components/ui/Button";
import { EmptyState, LoadingState, UnsupportedCapability } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiPost } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import {
  Card,
  describedBy,
  Field,
  InlineError,
  InlineStatus,
  LastKnownNote,
  SectionPage,
  SelectInput,
  settingsPath,
  useHydrated,
  validateAbsolutePath,
} from "./shared";
import { WORKTREE_DIR_HINT, worktreeDirProblem } from "./worktreeDir";

export const projectPath = (id: string) => settingsPath(`projects/${encodeURIComponent(id)}`);

/** Settings › Projects. */
export function ProjectsSection() {
  const hydrated = useHydrated();
  const projects = useProjects();
  const checkouts = useSyncStore((s) => s.checkouts);
  const workspaces = useSyncStore((s) => s.workspaces);
  const counts = useMemo(() => {
    const out: Record<string, { checkouts: number; workspaces: number }> = {};
    const get = (id: string) => {
      out[id] ??= { checkouts: 0, workspaces: 0 };
      return out[id];
    };
    for (const c of Object.values(checkouts)) get(c.projectId).checkouts++;
    for (const w of Object.values(workspaces)) if (!w.archivedAt) get(w.projectId).workspaces++;
    return out;
  }, [checkouts, workspaces]);

  return (
    <SectionPage
      testId="settings-projects"
      title="Projects"
      description="A project is one repository. It can have checkouts on several hosts. Repositories in a host's project folders are added automatically."
      actions={
        <Link to={settingsPath("projects/new")} className={buttonClasses("primary")}>
          <Plus aria-hidden className="size-4" />
          New project
        </Link>
      }
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 className="size-8" />}
          title="No projects yet"
          description="Create a project from a Git checkout on one of your hosts."
          action={{ label: "New project", to: settingsPath("projects/new") }}
        />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {projects.map((p) => (
            <li key={p.id} className="border-b border-border last:border-b-0">
              <ProjectRow project={p} counts={counts[p.id]} />
            </li>
          ))}
        </ul>
      )}
    </SectionPage>
  );
}

function ProjectRow({
  project: p,
  counts,
}: {
  project: Project;
  counts?: { checkouts: number; workspaces: number };
}) {
  const c = counts ?? { checkouts: 0, workspaces: 0 };
  return (
    <Link
      to={projectPath(p.id)}
      className="tap flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-surface-2"
    >
      <FolderGit2 aria-hidden className="size-5 shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words font-medium">{p.name}</span>
        <span className="break-all text-xs text-muted">{p.repoIdentity}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-muted">
          <span>
            {c.checkouts} checkout{c.checkouts === 1 ? "" : "s"}
          </span>
          <span>
            {c.workspaces} workspace{c.workspaces === 1 ? "" : "s"}
          </span>
          <span>Automation {p.automationEnabled ? "on" : "off"}</span>
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
    </Link>
  );
}

/** Settings › Projects › New. */
export function ProjectCreate() {
  const hydrated = useHydrated();
  const hosts = useHosts();
  const profilesById = useSyncStore((s) => s.profiles);
  const profiles = useMemo(
    () => Object.values(profilesById).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesById],
  );
  const connected = hosts.filter((h) => h.connectivity === "connected");
  const navigate = useNavigate();
  const ids = useId();
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState("");
  const [profileId, setProfileId] = useState("");
  const [worktreeDir, setWorktreeDir] = useState(".worktrees");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const effectiveHost = hostId || connected[0]?.id || "";
  const nameError = submitted && !name.trim() ? "Enter a project name." : null;
  const hostError = submitted && !effectiveHost ? "Choose a connected host." : null;
  const pathError = submitted || path ? validateAbsolutePath(path) : null;
  const worktreeDirError = worktreeDirProblem(worktreeDir);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !effectiveHost || validateAbsolutePath(path) || worktreeDirError) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ id?: string }>("/api/projects", {
        name: name.trim(),
        hostId: effectiveHost,
        path: path.trim(),
        defaultProfileId: profileId || null,
        worktreeDir: worktreeDir.trim(),
      });
      toast.success(`Project ${name.trim()} created`);
      navigate(res?.id ? projectPath(res.id) : settingsPath("projects"));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const back = { to: settingsPath("projects"), label: "Projects" };
  if (!hydrated)
    return (
      <SectionPage title="New project" back={back}>
        <LoadingState />
      </SectionPage>
    );

  return (
    <SectionPage
      title="New project"
      description="Switchyard inspects the checkout on the host, then discovers its worktrees."
      back={back}
    >
      {connected.length === 0 && (
        <UnsupportedCapability
          capability="Creating a project"
          reason={
            hosts.length === 0
              ? "No hosts are enrolled. Add a host first."
              : "No host is connected. The checkout is inspected on its host, so the host must be online."
          }
          fallback={
            <Link to={settingsPath("hosts")} className="font-medium text-accent">
              Open hosts
            </Link>
          }
        />
      )}
      <Card>
        <form className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
          <Field id={`${ids}-name`} label="Name" error={nameError}>
            <TextInput
              id={`${ids}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              {...describedBy(`${ids}-name`, { error: nameError })}
            />
          </Field>
          <Field
            id={`${ids}-host`}
            label="Host"
            hint="Only connected hosts are listed."
            error={hostError}
          >
            <SelectInput
              id={`${ids}-host`}
              value={effectiveHost}
              onChange={(e) => setHostId(e.target.value)}
              disabled={connected.length === 0}
              {...describedBy(`${ids}-host`, { hint: true, error: hostError })}
            >
              {connected.length === 0 && <option value="">No connected hosts</option>}
              {connected.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field
            id={`${ids}-path`}
            label="Checkout path on the host"
            hint="Absolute path of an existing Git checkout, e.g. /Users/me/src/app."
            error={pathError}
          >
            <TextInput
              id={`${ids}-path`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/me/src/app"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              {...describedBy(`${ids}-path`, { hint: true, error: pathError })}
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
              value={worktreeDir}
              onChange={(e) => setWorktreeDir(e.target.value)}
              placeholder=".worktrees"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              {...describedBy(`${ids}-worktree`, { hint: true, error: worktreeDirError })}
            />
          </Field>
          <Field id={`${ids}-profile`} label="Default Pi profile (optional)">
            <SelectInput
              id={`${ids}-profile`}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">None</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <InlineError error={error} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              icon={<FolderPlus className="size-4" />}
              disabled={connected.length === 0}
            >
              Create project
            </Button>
            {connected.length === 0 && (
              <InlineStatus icon={FolderPlus} label="Needs a connected host" />
            )}
          </div>
        </form>
      </Card>
    </SectionPage>
  );
}
