import type { Checkout, Host, Workspace } from "@switchyard/protocol";
import { GitBranch } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { usePrefs } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useProjects, useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import { branchProblem, workspaceLabel, worktreePath } from "./model";
import { rememberInitialPrompt } from "./startingPrompts";

type WsMode = "existing" | "new";

const SELECT_CLASS =
  "tap block h-9 w-full rounded-md border border-border bg-surface px-2 text-base text-text md:text-sm focus:border-accent focus:outline-none disabled:opacity-55";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function hostOnline(h: Host | undefined): boolean {
  return !!h && !h.revokedAt && h.connectivity === "connected";
}

function useNewSessionForm(open: boolean) {
  const projects = useProjects();
  const workspaces = useSyncStore((s) => s.workspaces);
  const checkouts = useSyncStore((s) => s.checkouts);
  const profilesMap = useSyncStore((s) => s.profiles);
  const hosts = useSyncStore((s) => s.hosts);
  const selectedProject = usePrefs((s) => s.selectedProjectId);
  const profiles = useMemo(
    () => Object.values(profilesMap).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesMap],
  );

  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<WsMode>("new");
  const [workspaceId, setWorkspaceId] = useState("");
  const [checkoutId, setCheckoutId] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");

  // Defaults when the flow opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize once per opening
  useEffect(() => {
    if (!open) return;
    const p = projects.find((x) => x.id === selectedProject) ?? projects[0] ?? null;
    setProjectId(p?.id ?? "");
  }, [open]);

  const project = projects.find((p) => p.id === projectId);
  const projectWorkspaces = useMemo(
    () =>
      Object.values(workspaces)
        .filter((w) => w.projectId === projectId && !w.archivedAt)
        .sort(
          (a, b) =>
            (a.provenance === "main" ? 0 : 1) - (b.provenance === "main" ? 0 : 1) ||
            (a.branch ?? "").localeCompare(b.branch ?? ""),
        ),
    [workspaces, projectId],
  );
  const projectCheckouts = useMemo(
    () => Object.values(checkouts).filter((c) => c.projectId === projectId),
    [checkouts, projectId],
  );

  // Project-dependent defaults.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-default when the project changes
  useEffect(() => {
    if (!project) return;
    const preferred =
      projectCheckouts.find(
        (c) => c.hostId === project.defaultHostId && hostOnline(hosts[c.hostId]),
      ) ??
      projectCheckouts.find((c) => hostOnline(hosts[c.hostId])) ??
      projectCheckouts[0];
    setCheckoutId(preferred?.id ?? "");
    const ws = projectWorkspaces.find((w) => hostOnline(hosts[w.hostId])) ?? projectWorkspaces[0];
    setWorkspaceId(ws?.id ?? "");
    setProfileId(project.defaultProfileId ?? profiles[0]?.id ?? "");
    setBase("");
  }, [projectId]);

  const workspace: Workspace | undefined = workspaces[workspaceId];
  const checkout: Checkout | undefined = checkouts[checkoutId];
  const hostId = mode === "existing" ? workspace?.hostId : checkout?.hostId;
  const host = hostId ? hosts[hostId] : undefined;

  const problems: string[] = [];
  if (!project) problems.push("Select a project.");
  if (mode === "existing" && !workspace) problems.push("Select a workspace.");
  if (mode === "new") {
    if (!checkout) problems.push("Select a host checkout.");
    const bp = branchProblem(branch);
    if (bp) problems.push(bp);
  }
  if (host && !hostOnline(host)) problems.push(`Host ${host.name} is offline.`);
  if (host && !host.piCompatible) {
    problems.push(
      `Pi ${host.piVersion ?? "(not found)"} on ${host.name} is outside the tested range.`,
    );
  }

  const preview =
    mode === "existing"
      ? workspace
        ? { branch: workspaceLabel(workspace), path: workspace.path }
        : null
      : checkout && branch.trim()
        ? { branch: branch.trim(), path: worktreePath(checkout.path, branch, project?.worktreeDir) }
        : null;

  return {
    projects,
    profiles,
    hosts,
    projectWorkspaces,
    projectCheckouts,
    project,
    workspace,
    checkout,
    host,
    preview,
    problems,
    values: { projectId, mode, workspaceId, checkoutId, branch, base, profileId, prompt },
    set: {
      projectId: setProjectId,
      mode: setMode,
      workspaceId: setWorkspaceId,
      checkoutId: setCheckoutId,
      branch: setBranch,
      base: setBase,
      profileId: setProfileId,
      prompt: setPrompt,
    },
    reset: () => {
      setBranch("");
      setBase("");
      setPrompt("");
    },
  };
}

type Form = ReturnType<typeof useNewSessionForm>;

function ProjectField({ form, id }: { form: Form; id: string }) {
  return (
    <Field label="Project" htmlFor={`${id}-project`}>
      <select
        id={`${id}-project`}
        className={SELECT_CLASS}
        value={form.values.projectId}
        onChange={(e) => form.set.projectId(e.target.value)}
      >
        {form.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function WorkspaceFields({ form, id }: { form: Form; id: string }) {
  const { values, set, hosts } = form;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Workspace</legend>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`${id}-wsmode`}
            checked={values.mode === "new"}
            onChange={() => set.mode("new")}
            className="size-4"
          />
          Create a new worktree
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`${id}-wsmode`}
            checked={values.mode === "existing"}
            onChange={() => set.mode("existing")}
            disabled={form.projectWorkspaces.length === 0}
            className="size-4"
          />
          Use an existing workspace
          {form.projectWorkspaces.length === 0 && (
            <span className="text-xs text-muted">(none discovered)</span>
          )}
        </label>
      </div>
      {values.mode === "existing" ? (
        <Field
          label="Existing workspace"
          htmlFor={`${id}-ws`}
          hint={form.host ? `Runs on ${form.host.name}` : undefined}
        >
          <select
            id={`${id}-ws`}
            className={SELECT_CLASS}
            value={values.workspaceId}
            onChange={(e) => set.workspaceId(e.target.value)}
          >
            {form.projectWorkspaces.map((w) => {
              const h = hosts[w.hostId];
              return (
                <option key={w.id} value={w.id} disabled={!hostOnline(h)}>
                  {workspaceLabel(w)} on {h?.name ?? "unknown host"}
                  {hostOnline(h) ? "" : " (host offline)"}
                </option>
              );
            })}
          </select>
        </Field>
      ) : (
        <>
          <Field label="Host and checkout" htmlFor={`${id}-checkout`}>
            <select
              id={`${id}-checkout`}
              className={SELECT_CLASS}
              value={values.checkoutId}
              onChange={(e) => set.checkoutId(e.target.value)}
            >
              {form.projectCheckouts.length === 0 && <option value="">No checkouts</option>}
              {form.projectCheckouts.map((c) => {
                const h = hosts[c.hostId];
                return (
                  <option key={c.id} value={c.id} disabled={!hostOnline(h)}>
                    {h?.name ?? "Unknown host"}: {c.path}
                    {hostOnline(h) ? "" : " (host offline)"}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field
            label="New branch"
            htmlFor={`${id}-branch`}
            hint={values.branch ? branchProblem(values.branch) : undefined}
          >
            <TextInput
              id={`${id}-branch`}
              value={values.branch}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. fix/login-retry"
              onChange={(e) => set.branch(e.target.value)}
            />
          </Field>
          <Field
            label="Base branch (optional)"
            htmlFor={`${id}-base`}
            hint={`Defaults to ${form.checkout?.defaultBranch ?? "the default branch"}.`}
          >
            <TextInput
              id={`${id}-base`}
              value={values.base}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={form.checkout?.defaultBranch ?? "main"}
              onChange={(e) => set.base(e.target.value)}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}

function ProfileField({ form, id }: { form: Form; id: string }) {
  const p = form.profiles.find((x) => x.id === form.values.profileId);
  return (
    <Field
      label="Pi profile"
      htmlFor={`${id}-profile`}
      hint={
        p
          ? [p.provider, p.model, p.thinking ? `effort ${p.thinking}` : null]
              .filter(Boolean)
              .join(" · ") || "Pi defaults"
          : undefined
      }
    >
      <select
        id={`${id}-profile`}
        className={SELECT_CLASS}
        value={form.values.profileId}
        onChange={(e) => form.set.profileId(e.target.value)}
      >
        {form.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {form.project?.defaultProfileId === p.id ? " (project default)" : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PromptField({ form, id }: { form: Form; id: string }) {
  return (
    <Field label="Initial prompt (optional)" htmlFor={`${id}-prompt`}>
      <TextArea
        id={`${id}-prompt`}
        minRows={3}
        maxHeight="30vh"
        value={form.values.prompt}
        placeholder="What should Pi work on?"
        onChange={(e) => form.set.prompt(e.target.value)}
      />
    </Field>
  );
}

function Preview({ form }: { form: Form }) {
  return (
    <section
      aria-label="Preview"
      data-testid="new-session-preview"
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface-2 p-3 text-sm"
    >
      <h3 className="flex items-center gap-1.5 font-medium">
        <GitBranch aria-hidden className="size-4" />
        Result
      </h3>
      {form.preview ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-muted">Branch</dt>
          <dd className="min-w-0 font-mono text-xs break-all">{form.preview.branch}</dd>
          <dt className="text-muted">Path</dt>
          <dd className="min-w-0 font-mono text-xs break-all">{form.preview.path}</dd>
          <dt className="text-muted">Host</dt>
          <dd className="min-w-0 break-words">{form.host?.name ?? "Unknown"}</dd>
        </dl>
      ) : (
        <p className="text-muted">Choose a workspace to see the branch and path.</p>
      )}
      {form.values.mode === "new" && form.preview && (
        <p className="text-xs text-muted">A new Git worktree is created at this path.</p>
      )}
    </section>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted" aria-live="polite">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

const STEPS = ["Project", "Workspace", "Profile", "Prompt"] as const;

/**
 * New session: a dialog on desktop, sequential sheets on mobile. Creating
 * posts `/api/sessions` and opens the session at once; the session view shows
 * its starting progress until Pi is ready.
 */
export function NewSessionFlow({
  open,
  onClose,
  onCreated,
  mobile,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  mobile: boolean;
}) {
  const id = useId();
  const form = useNewSessionForm(open);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) {
      setStep(0);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const create = async () => {
    if (form.problems.length || submitting) return;
    const v = form.values;
    setSubmitting(true);
    setError(null);
    try {
      const s = await codeApi.createSession({
        projectId: v.projectId,
        workspace:
          v.mode === "existing"
            ? { existingId: v.workspaceId }
            : { checkoutId: v.checkoutId, newBranch: v.branch.trim(), base: v.base.trim() || null },
        profileId: v.profileId || null,
        prompt: v.prompt,
      });
      useSyncStore.getState().upsertSessionIfMissing(s);
      rememberInitialPrompt(s.id, v.prompt);
      form.reset();
      onCreated(s.id);
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const errorBox =
    error !== null ? (
      <ErrorState
        compact
        title="Could not create the session"
        error={errorMessage(error)}
        onRetry={() => void create()}
      />
    ) : null;

  if (!mobile) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="New session"
        description="A task is not required."
        dismissOnBackdrop={!submitting}
        className="max-w-xl"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              busy={submitting}
              disabled={form.problems.length > 0}
              onClick={() => void create()}
            >
              Create session
            </Button>
          </>
        }
      >
        {form.projects.length === 0 ? (
          <p className="text-sm text-muted">Add a project in Settings first.</p>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <ProjectField form={form} id={id} />
            <WorkspaceFields form={form} id={id} />
            <ProfileField form={form} id={id} />
            <PromptField form={form} id={id} />
            <Preview form={form} />
            <Problems problems={form.problems} />
            {errorBox}
          </form>
        )}
      </Dialog>
    );
  }

  const last = step === STEPS.length - 1;
  const stepProblems =
    step === 0
      ? form.project
        ? []
        : ["Select a project."]
      : step === 1
        ? form.problems.filter((p) => p !== "Select a project.")
        : [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`New session: ${STEPS[step]}`}
      description={`Step ${step + 1} of ${STEPS.length}`}
      dismissOnBackdrop={!submitting}
      footer={
        <>
          {step > 0 && (
            <Button onClick={() => setStep((s) => s - 1)} disabled={submitting}>
              Back
            </Button>
          )}
          {last ? (
            <Button
              variant="primary"
              busy={submitting}
              disabled={form.problems.length > 0}
              onClick={() => void create()}
            >
              Create session
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={stepProblems.length > 0}
              onClick={() => setStep((s) => s + 1)}
            >
              Next
            </Button>
          )}
        </>
      }
    >
      <ol aria-label="Steps" className="mb-3 flex gap-1">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-border")}
          >
            <span className="sr-only">
              {s}
              {i < step ? " (done)" : ""}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-col gap-4">
        {step === 0 && <ProjectField form={form} id={id} />}
        {step === 1 && <WorkspaceFields form={form} id={id} />}
        {step === 2 && <ProfileField form={form} id={id} />}
        {step === 3 && (
          <>
            <PromptField form={form} id={id} />
            <Preview form={form} />
          </>
        )}
        {step === 1 && <Preview form={form} />}
        <Problems problems={last ? form.problems : stepProblems} />
        {errorBox}
      </div>
    </Sheet>
  );
}
