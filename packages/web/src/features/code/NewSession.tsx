import { ChevronDown, ChevronRight, GitBranch, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { ErrorState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { usePrefs } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useProjects, useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import {
  branchFromPrompt,
  branchProblem,
  compareWorkspaces,
  hostOnline,
  newSessionDefaults,
  uniqueBranch,
  workspaceLabel,
  worktreePath,
} from "./model";
import { CHIP_SELECT, ProjectPicker } from "./ProjectPicker";
import { rememberInitialPrompt } from "./startingPrompts";

const NEW = "__new";

function useNewSessionForm(open: boolean, initialProjectId: string | null) {
  const projects = useProjects();
  const workspaces = useSyncStore((s) => s.workspaces);
  const checkouts = useSyncStore((s) => s.checkouts);
  const profilesMap = useSyncStore((s) => s.profiles);
  const hosts = useSyncStore((s) => s.hosts);
  const projectsById = useSyncStore((s) => s.projects);
  const selectedProject = usePrefs((s) => s.selectedProjectId);
  const lastProject = usePrefs((s) => s.lastNewSessionProjectId);
  const profiles = useMemo(
    () => Object.values(profilesMap).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesMap],
  );

  const [projectId, setProjectId] = useState("");
  const [hostId, setHostId] = useState("");
  const [workspaceId, setWorkspaceId] = useState(NEW);
  const [checkoutId, setCheckoutId] = useState("");
  const [branch, setBranch] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [base, setBase] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Defaults when the flow opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize once per opening
  useEffect(() => {
    if (!open) return;
    const pick = [initialProjectId, lastProject, selectedProject].find(
      (id) => !!id && !!projectsById[id],
    );
    setProjectId(pick ?? projects[0]?.id ?? "");
  }, [open, initialProjectId]);

  const project = projects.find((p) => p.id === projectId);
  const projectWorkspaces = useMemo(
    () => Object.values(workspaces).filter((w) => w.projectId === projectId && !w.archivedAt),
    [workspaces, projectId],
  );
  const projectCheckouts = useMemo(
    () =>
      Object.values(checkouts)
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [checkouts, projectId],
  );
  const hostIds = useMemo(
    () =>
      [...new Set(projectCheckouts.map((c) => c.hostId))].sort((a, b) =>
        (hosts[a]?.name ?? "").localeCompare(hosts[b]?.name ?? ""),
      ),
    [projectCheckouts, hosts],
  );

  // Project-dependent defaults.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-default when the flow opens or the project changes
  useEffect(() => {
    if (!open || !project) return;
    const d = newSessionDefaults(project, projectCheckouts, projectWorkspaces, hosts);
    setHostId(d.hostId);
    setWorkspaceId(d.workspaceId ?? NEW);
    setCheckoutId(d.checkoutId ?? "");
    setProfileId("");
    setBase("");
    setBranch("");
    setBranchTouched(false);
  }, [open, projectId]);

  const changeHost = (id: string) => {
    if (!project) return;
    const d = newSessionDefaults(project, projectCheckouts, projectWorkspaces, hosts, id);
    setHostId(d.hostId);
    setWorkspaceId(d.workspaceId ?? NEW);
    setCheckoutId(d.checkoutId ?? "");
  };

  const hostWorkspaces = useMemo(
    () => projectWorkspaces.filter((w) => w.hostId === hostId).sort(compareWorkspaces),
    [projectWorkspaces, hostId],
  );
  const hostCheckouts = useMemo(
    () => projectCheckouts.filter((c) => c.hostId === hostId),
    [projectCheckouts, hostId],
  );
  const mode = workspaceId === NEW ? "new" : "existing";
  const workspace = mode === "existing" ? workspaces[workspaceId] : undefined;
  const checkout = checkouts[checkoutId] ?? hostCheckouts[0];
  const host = hosts[hostId];
  const suggested = useMemo(
    () =>
      uniqueBranch(
        branchFromPrompt(prompt),
        projectWorkspaces.map((w) => w.branch),
      ),
    [prompt, projectWorkspaces],
  );
  const effectiveBranch = branchTouched ? branch : suggested;

  let problem: string | null = null;
  if (!project) problem = "Choose a project.";
  else if (hostIds.length === 0)
    problem = "This project has no checkout yet. Add one in Settings › Projects.";
  else if (!host) problem = "Choose a host.";
  else if (!hostOnline(host)) problem = `${host.name} is offline.`;
  else if (!host.piCompatible) {
    problem = `Pi ${host.piVersion ?? "(not found)"} on ${host.name} is outside the tested range.`;
  } else if (mode === "existing" && !workspace) problem = "Choose a workspace.";
  else if (mode === "new" && !checkout) problem = `No checkout of ${project.name} on ${host.name}.`;
  else if (mode === "new") problem = branchProblem(effectiveBranch);

  let summary: { text: string; path: string } | null = null;
  if (workspace) {
    summary = {
      text: `${workspaceLabel(workspace)} on ${host?.name ?? "unknown host"}`,
      path: workspace.path,
    };
  } else if (mode === "new" && checkout) {
    summary = {
      text: `New worktree ${effectiveBranch.trim()} from ${base.trim() || checkout.defaultBranch} on ${host?.name ?? "unknown host"}`,
      path: worktreePath(checkout.path, effectiveBranch, project?.worktreeDir),
    };
  }

  return {
    projects,
    profiles,
    hosts,
    project,
    projectId,
    setProjectId,
    hostId,
    hostIds,
    changeHost,
    workspaceId,
    setWorkspaceId,
    hostWorkspaces,
    hostCheckouts,
    setCheckoutId,
    mode,
    workspace,
    checkout,
    host,
    branch,
    setBranch,
    branchTouched,
    setBranchTouched,
    base,
    setBase,
    profileId,
    setProfileId,
    prompt,
    setPrompt,
    title,
    setTitle,
    advancedOpen,
    setAdvancedOpen,
    suggested,
    effectiveBranch,
    problem,
    summary,
    reset: () => {
      setPrompt("");
      setTitle("");
      setBranch("");
      setBranchTouched(false);
      setBase("");
      setAdvancedOpen(false);
    },
  };
}

/**
 * New session: prompt first, then project, workspace, host and profile as
 * compact choices. A dialog on desktop, one full-height sheet on mobile.
 * Creating posts `/api/sessions` and opens the session at once; the session view
 * shows its starting progress until Pi is ready.
 */
export function NewSessionFlow({
  open,
  onClose,
  onCreated,
  mobile,
  projectId = null,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  mobile: boolean;
  projectId?: string | null;
}) {
  const id = useId();
  const f = useNewSessionForm(open, projectId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const create = async () => {
    if (f.problem || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const s = await codeApi.createSession({
        projectId: f.projectId,
        workspace:
          f.mode === "existing"
            ? { existingId: f.workspaceId }
            : {
                checkoutId: f.checkout?.id ?? "",
                newBranch: f.effectiveBranch.trim(),
                base: f.base.trim() || null,
              },
        profileId: f.profileId || null,
        prompt: f.prompt,
        ...(f.title.trim() ? { title: f.title.trim() } : {}),
      });
      useSyncStore.getState().upsertSessionIfMissing(s);
      rememberInitialPrompt(s.id, f.prompt);
      usePrefs.getState().set("lastNewSessionProjectId", f.projectId);
      f.reset();
      onCreated(s.id);
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void create();
    }
  };
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = mac ? "⌘ Enter" : "Ctrl+Enter";
  const defaultProfile = f.profiles.find((p) => p.id === f.project?.defaultProfileId);

  const errorBox =
    error !== null ? (
      <ErrorState
        compact
        title="Could not create the session"
        error={errorMessage(error)}
        onRetry={() => void create()}
      />
    ) : null;

  const body =
    f.projects.length === 0 ? (
      <p className="text-sm text-muted">Add a project in Settings first.</p>
    ) : (
      <form
        className="flex min-w-0 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        onKeyDown={onKeyDown}
      >
        <label htmlFor={`${id}-prompt`} className="text-base font-medium">
          What should Pi do? <span className="text-sm font-normal text-muted">(optional)</span>
        </label>
        <TextArea
          id={`${id}-prompt`}
          autoFocus
          minRows={mobile ? 6 : 5}
          maxHeight="40vh"
          value={f.prompt}
          onChange={(e) => f.setPrompt(e.target.value)}
          placeholder="Describe the task. Leave empty to start Pi without a prompt."
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the chip row */}
        <div
          role="group"
          aria-label="Session options"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          <ProjectPicker projects={f.projects} value={f.projectId} onChange={f.setProjectId} />
          <label htmlFor={`${id}-ws`} className="sr-only">
            Workspace
          </label>
          <select
            id={`${id}-ws`}
            className={CHIP_SELECT}
            value={f.workspaceId}
            onChange={(e) => f.setWorkspaceId(e.target.value)}
          >
            {f.hostWorkspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {workspaceLabel(w)}
                {w.provenance === "main" ? " (main checkout)" : ""}
              </option>
            ))}
            <option value={NEW} disabled={f.hostCheckouts.length === 0}>
              New worktree…
            </option>
          </select>
          {f.hostIds.length > 1 && (
            <>
              <label htmlFor={`${id}-host`} className="sr-only">
                Host
              </label>
              <select
                id={`${id}-host`}
                className={CHIP_SELECT}
                value={f.hostId}
                onChange={(e) => f.changeHost(e.target.value)}
              >
                {f.hostIds.map((h) => (
                  <option key={h} value={h} disabled={!hostOnline(f.hosts[h])}>
                    {f.hosts[h]?.name ?? "Removed host"}
                    {hostOnline(f.hosts[h]) ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            </>
          )}
          {f.profiles.length > 0 && (
            <>
              <label htmlFor={`${id}-profile`} className="sr-only">
                Pi profile
              </label>
              <select
                id={`${id}-profile`}
                className={CHIP_SELECT}
                value={f.profileId}
                onChange={(e) => f.setProfileId(e.target.value)}
              >
                <option value="">
                  {defaultProfile ? `${defaultProfile.name} (project default)` : "Pi defaults"}
                </option>
                {f.profiles
                  .filter((p) => p.id !== f.project?.defaultProfileId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </>
          )}
        </div>
        {f.mode === "new" && (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <Field
              label="Branch"
              id={`${id}-branch`}
              hint={
                <>
                  {branchProblem(f.effectiveBranch) ??
                    (f.branchTouched && f.branch !== f.suggested
                      ? "Custom branch name."
                      : "Suggested from the prompt.")}
                  {f.branchTouched && f.branch !== f.suggested && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="font-medium text-accent"
                        onClick={() => {
                          f.setBranch("");
                          f.setBranchTouched(false);
                        }}
                      >
                        Use suggested name
                      </button>
                    </>
                  )}
                </>
              }
            >
              <TextInput
                id={`${id}-branch`}
                value={f.effectiveBranch}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  f.setBranch(e.target.value);
                  f.setBranchTouched(true);
                }}
              />
            </Field>
            <Field
              label="Base branch"
              id={`${id}-base`}
              hint={`Defaults to ${f.checkout?.defaultBranch ?? "the default branch"}.`}
            >
              <TextInput
                id={`${id}-base`}
                value={f.base}
                placeholder={f.checkout?.defaultBranch ?? "main"}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => f.setBase(e.target.value)}
              />
            </Field>
          </div>
        )}
        <div>
          <button
            type="button"
            aria-expanded={f.advancedOpen}
            aria-controls={`${id}-adv`}
            onClick={() => f.setAdvancedOpen(!f.advancedOpen)}
            className="tap inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-text"
          >
            {f.advancedOpen ? (
              <ChevronDown aria-hidden className="size-4" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )}
            Advanced
          </button>
          {f.advancedOpen && (
            <div id={`${id}-adv`} className="mt-2 flex min-w-0 flex-col gap-3">
              <Field label="Session title" optional id={`${id}-title`}>
                <TextInput
                  id={`${id}-title`}
                  value={f.title}
                  placeholder="Named from the prompt"
                  onChange={(e) => f.setTitle(e.target.value)}
                />
              </Field>
              {f.mode === "new" && f.hostCheckouts.length > 1 && (
                <Field label="Checkout" id={`${id}-checkout`}>
                  <Select
                    id={`${id}-checkout`}
                    value={f.checkout?.id ?? ""}
                    onChange={(e) => f.setCheckoutId(e.target.value)}
                  >
                    {f.hostCheckouts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.path}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}
        </div>
        {f.summary && (
          <p
            data-testid="new-session-summary"
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted"
            title={f.summary.path}
          >
            <GitBranch aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {f.summary.text} · <span className="font-mono">{f.summary.path}</span>
            </span>
          </p>
        )}
        {errorBox}
      </form>
    );

  const footer = (
    <>
      {f.problem ? (
        <p
          role="status"
          aria-live="polite"
          className="mr-auto flex min-w-0 flex-1 basis-full items-start gap-1 text-xs text-muted sm:basis-auto"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {f.problem}
        </p>
      ) : !mobile ? (
        <span className="mr-auto text-xs text-subtle">{shortcut} to create</span>
      ) : null}
      <Button onClick={onClose}>Cancel</Button>
      <Button
        variant="primary"
        busy={submitting}
        disabled={!!f.problem}
        onClick={() => void create()}
      >
        Create session
      </Button>
    </>
  );

  if (!mobile) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="New session"
        dismissOnBackdrop={!submitting}
        className="max-w-xl"
        footer={footer}
      >
        {body}
      </Dialog>
    );
  }
  return (
    <Sheet
      fullHeight
      open={open}
      onClose={onClose}
      title="New session"
      dismissOnBackdrop={!submitting}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
