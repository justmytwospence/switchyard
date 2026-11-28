import {
  issueBranchSet,
  issueBranchSetHas,
  issueLookup,
  issueUnstarted,
  primarySession,
  type Scope,
  type Session,
} from "@switchyard/protocol";
import { ChevronDown, ChevronRight, GitBranch, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Field } from "../../components/ui/Field";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { ErrorState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { loadDraft, setDraftNow } from "../../drafts";
import { useFilter, usePrefs } from "../../prefs";
import { errorMessage, isApiError } from "../../sync/api";
import { useProjects, useSyncStore } from "../../sync/store";
import { InventoryEmpty, InventoryMore, InventoryStatus } from "../discovery/InventoryStatus";
import { IssueList } from "../discovery/IssueList";
import { IssuePreview } from "../discovery/IssuePreview";
import { issueAction } from "../discovery/issueAction";
import {
  discoveryContext,
  githubRepository,
  type IssueLocator,
  issueLocatorKey,
} from "../discovery/model";
import { ScopeRepository } from "../discovery/ScopeRepository";
import { rememberIssueSession, useIssueInventory } from "../discovery/useIssueInventory";
import { currentScopeId } from "../scopes/selection";
import { effectiveWhere, useSelectedWhere, whereLabel } from "../scopes/where";
import { CheckoutPrepare } from "../settings/CheckoutPrepare";
import { openIssue } from "../workboard/api";
import { codeApi } from "./api";
import {
  branchFromPrompt,
  branchProblem,
  compareWorkspaces,
  hostOnline,
  newSessionDefaults,
  newSessionProject,
  orderProjectsForScope,
  sessionHostIds,
  uniqueBranch,
  workspaceLabel,
  worktreePath,
} from "./model";
import { CHIP_SELECT, ProjectPicker } from "./ProjectPicker";
import { useSelectedScope } from "./scopes";
import { rememberInitialPrompt } from "./startingPrompts";

const NEW = "__new";

function useNewSessionForm(
  open: boolean,
  initialProjectId: string | null,
  scope: Scope | null,
  /** An explicit run location from the host filter. */
  preferHostId: string | null = null,
) {
  const allProjects = useProjects();
  const scopeProjectIds = scope && scope.mode === "all" ? scope.projectIds : null;
  const projects = useMemo(
    () => orderProjectsForScope(allProjects, scopeProjectIds),
    [allProjects, scopeProjectIds],
  );
  const issues = useSyncStore((s) => s.issues);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const checkouts = useSyncStore((s) => s.checkouts);
  const profilesMap = useSyncStore((s) => s.profiles);
  const hosts = useSyncStore((s) => s.hosts);
  const selectedProject = usePrefs((s) => s.selectedProjectId);
  const lastProject = usePrefs((s) => s.lastNewSessionProjectId);
  const profiles = useMemo(
    () => Object.values(profilesMap).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesMap],
  );

  const [projectId, setProjectId] = useState("");
  const [chosenHostId, setHostId] = useState("");
  const [workspaceId, setWorkspaceId] = useState(NEW);
  const [checkoutId, setCheckoutId] = useState("");
  const [branch, setBranch] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [base, setBase] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [another, setAnother] = useState(false);

  // Defaults when the flow opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize once per opening
  useEffect(() => {
    if (!open) return;
    setProjectId(
      newSessionProject({
        initial: initialProjectId,
        last: lastProject,
        selected: selectedProject,
        ordered: projects,
        scopeProjectIds,
      }),
    );
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
    () => (project ? sessionHostIds(project, projectCheckouts, hosts) : []),
    [project, projectCheckouts, hosts],
  );
  const defaults = project
    ? newSessionDefaults(
        project,
        projectCheckouts,
        projectWorkspaces,
        hosts,
        preferHostId ?? undefined,
      )
    : null;
  const hostId = chosenHostId || defaults?.hostId || "";

  // Project-dependent defaults.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-default when the flow opens or the project changes
  useEffect(() => {
    if (!open || !project) return;
    setHostId(defaults?.hostId ?? "");
    setWorkspaceId(defaults?.workspaceId ?? NEW);
    setCheckoutId(defaults?.checkoutId ?? "");
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
  const mode: "new" | "existing" = workspaceId === NEW ? "new" : "existing";
  const workspace = mode === "existing" ? workspaces[workspaceId] : undefined;
  const issueOf = useMemo(() => issueLookup(Object.values(issues)), [issues]);
  /** The branch's primary session per workspace (only workspaces that have one). */
  const occupants = useMemo(() => {
    const by = new Map<string, Session[]>();
    for (const x of Object.values(sessions)) {
      if (x.archivedAt !== null || x.provenance === "subagent" || !x.workspaceId) continue;
      const list = by.get(x.workspaceId);
      if (list) list.push(x);
      else by.set(x.workspaceId, [x]);
    }
    const out = new Map<string, Session>();
    for (const [id, list] of by) {
      const p = primarySession(list);
      if (p) out.set(id, p);
    }
    return out;
  }, [sessions]);
  const occupant = workspace ? (occupants.get(workspace.id) ?? null) : null;
  // A new choice of workspace starts from opening its session again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the workspace changes
  useEffect(() => setAnother(false), [workspaceId]);
  const checkout = hostCheckouts.find((c) => c.id === checkoutId) ?? hostCheckouts[0];
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

  const needsCheckout =
    !checkout || (!!project?.catalog && !hostWorkspaces.some((w) => w.checkoutId === checkout.id));
  let placementProblem: string | null = null;
  if (!project) placementProblem = "Choose an active project.";
  else if (!host)
    placementProblem = project.catalog
      ? "Connect or select a host before starting."
      : "Attach an existing checkout in Settings › Projects.";
  else if (!hostOnline(host))
    placementProblem = `${host.name} is offline. Reconnect it or choose another host.`;
  else if (!host.piCompatible) {
    placementProblem = `Update Pi on ${host.name}; ${host.piVersion ?? "no Pi installation"} is outside the tested range.`;
  } else if (needsCheckout) placementProblem = "Prepare a checkout on this host before starting.";

  const problem =
    placementProblem ??
    (mode === "existing" && !workspace
      ? "Choose a workspace."
      : mode === "new"
        ? branchProblem(effectiveBranch)
        : null);

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
    issueOf,
    occupants,
    occupant,
    another,
    setAnother,
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
    needsCheckout,
    placementProblem,
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
  initialMode,
  initialIssue,
  browseRepository,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  mobile: boolean;
  projectId?: string | null;
  initialMode?: "prompt" | "issue";
  initialIssue?: IssueLocator;
  browseRepository?: boolean;
}) {
  const id = useId();
  const [selectedScope] = useSelectedScope();
  const knownScopes = useSyncStore((st) => st.scopes);
  const issues = useSyncStore((st) => st.issues);
  const scope = (selectedScope ? knownScopes[selectedScope] : null) ?? null;
  const hostsById = useSyncStore((st) => st.hosts);
  const [storedWhere] = useSelectedWhere();
  const where = effectiveWhere(storedWhere, hostsById);
  const f = useNewSessionForm(open, projectId, scope, where?.kind === "host" ? where.id : null);
  const [submitting, setSubmitting] = useState(false);
  const [preparingCheckout, setPreparingCheckout] = useState(false);
  const inFlight = useRef(false);
  const promptProject = useRef<string | null>(null);
  const issueBack = useRef<HTMLButtonElement>(null);
  const issueOrigin = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [storedMode, setStoredMode] = useFilter<"prompt" | "issue">("new-session-mode", "prompt");
  const [launchMode, setLaunchMode] = useState<"prompt" | "issue">("prompt");
  const [issueId, setIssueId] = useState<string | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [explicitProjectId, setExplicitProjectId] = useState<string | null>(null);
  const [trackedPreview, setTrackedPreview] = useState(false);
  const [query, setQuery] = useState("");
  const [subset, setSubset] = useState<"notStarted" | "all">("notStarted");
  const [sort, setSort] = useFilter<"number" | "priority">("discovery-sort", "number");
  const [instruction, setInstruction] = useState("");
  const [overrideDestination, setOverrideDestination] = useState(false);
  const projectsById = useSyncStore((s) => s.projects);
  const checkouts = useSyncStore((s) => s.checkouts);
  const hydrated = useSyncStore((s) => s.hydrated);
  const context = discoveryContext(scope, f.projects);
  const issueProjectId = explicitProjectId ?? repositoryId ?? context.fixedProjectId;
  const inventory = useIssueInventory({
    enabled: open && hydrated && launchMode === "issue",
    scope,
    projectId: repositoryId,
    entry: explicitProjectId ? { kind: "repository", projectId: explicitProjectId } : undefined,
    forceTracked: trackedPreview,
    query,
    subset,
    sort,
  });
  const selectedIssue = inventory.allItems.find((item) => item.id === issueId);
  const action = selectedIssue
    ? issueAction(selectedIssue, {
        instruction,
        hostId: f.hostId,
        profileId: f.profileId,
        hosts: hostsById,
        checkouts,
        scopes: knownScopes,
        projects: projectsById,
      })
    : null;
  const issueCollision =
    !!selectedIssue?.sessionId &&
    !!instruction.trim() &&
    !!loadDraft(selectedIssue.sessionId).trim();

  // Initialize only on opening or a new route request, not when preferences change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening is the boundary
  useEffect(() => {
    if (!open) return;
    promptProject.current = null;
    issueOrigin.current = null;
    setLaunchMode(initialMode ?? storedMode);
    setIssueId(initialIssue ? issueLocatorKey(initialIssue) : null);
    setTrackedPreview(initialIssue?.kind === "tracked");
    setRepositoryId(
      !initialIssue &&
        projectId &&
        (!scope ||
          (scope.mode !== "pinned" &&
            (scope.projectIds === null || scope.projectIds.includes(projectId))))
        ? projectId
        : null,
    );
    setExplicitProjectId(
      initialIssue?.kind === "repository"
        ? initialIssue.projectId
        : browseRepository
          ? projectId
          : null,
    );
    setQuery("");
    setSubset(initialIssue ? "all" : "notStarted");
    setInstruction("");
    setOverrideDestination(
      !!projectId && !!context.fixedProjectId && projectId !== context.fixedProjectId,
    );
  }, [open, initialMode, initialIssue, browseRepository, projectId, selectedScope]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (
      open &&
      launchMode === "issue" &&
      hydrated &&
      !inventory.loading &&
      issueId &&
      !selectedIssue
    ) {
      setIssueId(null);
      setTrackedPreview(false);
      setInstruction("");
      toast.error("That issue is no longer available in this scope.");
    }
  }, [open, launchMode, hydrated, inventory.loading, issueId, selectedIssue]);

  const inspectedId = selectedIssue?.id;
  useEffect(() => {
    if (!open || launchMode !== "issue") return;
    if (inspectedId) issueBack.current?.focus();
    else issueOrigin.current?.focus();
  }, [open, launchMode, inspectedId]);

  // A selected issue determines the launch destination, independently of workspace resets.
  useEffect(() => {
    if (
      open &&
      launchMode === "issue" &&
      selectedIssue &&
      f.projectId !== selectedIssue.projectId
    ) {
      if (!promptProject.current && f.projectId) promptProject.current = f.projectId;
      f.setProjectId(selectedIssue.projectId);
    }
  }, [open, launchMode, selectedIssue, f.projectId, f.setProjectId]);

  const reuse = !!f.occupant && !f.another;
  const issueSet = useMemo(
    () => (scope ? issueBranchSet(scope, Object.values(issues)) : null),
    [scope, issues],
  );
  const linked =
    f.mode === "existing" &&
    !!f.workspace &&
    !!issueSet &&
    issueBranchSetHas(issueSet, f.workspace);
  const leaves =
    !!scope &&
    !!issueSet &&
    !reuse &&
    !linked &&
    (scope.projectIds === null || scope.projectIds.includes(f.projectId));
  const create = async () => {
    if (inFlight.current || preparingCheckout) return;
    if (launchMode === "issue") {
      const state = useSyncStore.getState();
      const freshScope = selectedScope ? state.scopes[selectedScope] : null;
      if (currentScopeId() !== selectedScope || (selectedScope && !freshScope) || !issueId) return;
      const fresh = inventory.currentItem(issueId, freshScope ?? null);
      if (!fresh) return;
      if (fresh.sessionId) {
        if (instruction.trim() && loadDraft(fresh.sessionId).trim()) return;
        if (instruction.trim()) setDraftNow(fresh.sessionId, instruction);
        setInstruction("");
        onCreated(fresh.sessionId);
        return;
      }
      if (issueProblem || f.projectId !== fresh.projectId) return;
      const freshAction = issueAction(fresh, {
        instruction,
        hostId: f.hostId,
        profileId: f.profileId,
        hosts: state.hosts,
        checkouts: state.checkouts,
        scopes: state.scopes,
        projects: state.projects,
      });
      if (freshAction.kind !== "start") return;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const result = await openIssue(freshAction.locator, freshAction.request);
        rememberIssueSession(fresh, result.session);
        if (result.created) rememberInitialPrompt(result.session.id, instruction);
        else if (instruction.trim()) {
          if (loadDraft(result.session.id).trim()) {
            setError(
              new Error(
                "An existing session has a draft. Copy or clear your instruction before opening it.",
              ),
            );
            return;
          }
          setDraftNow(result.session.id, instruction);
        }
        setInstruction("");
        onCreated(result.session.id);
      } catch (e) {
        setError(e);
        if (
          fresh.locator.kind === "repository" &&
          isApiError(e) &&
          (e.status === 409 || e.status === 404)
        ) {
          inventory.refresh?.();
        }
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
      return;
    }
    if (f.problem) return;
    if (reuse && f.occupant) {
      // The prompt waits in the existing session's composer instead of starting a new one.
      if (f.prompt.trim() && !loadDraft(f.occupant.id).trim()) setDraftNow(f.occupant.id, f.prompt);
      const id = f.occupant.id;
      f.reset();
      onCreated(id);
      return;
    }
    inFlight.current = true;
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
      inFlight.current = false;
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
        {...(launchMode === "prompt" ? { onRetry: () => void create() } : {})}
      />
    ) : null;

  const promptBody =
    f.projects.length === 0 ? (
      <p className="text-sm text-muted">
        Connect GitHub in <TextLink to="/settings/projects">Settings › Projects</TextLink> to select
        repositories.
      </p>
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
          {context.fixedProjectId && !overrideDestination ? (
            <>
              <span className="text-sm">
                {scope?.name}
                {scope && f.project && scope.name.toLowerCase() !== f.project.name.toLowerCase()
                  ? ` · ${f.project.name}`
                  : ""}
              </span>
              <button
                type="button"
                className="text-sm text-accent"
                disabled={preparingCheckout}
                onClick={() => setOverrideDestination(true)}
              >
                Choose a different repository
              </button>
            </>
          ) : (
            <ProjectPicker
              projects={f.projects}
              value={f.projectId}
              onChange={f.setProjectId}
              disabled={preparingCheckout}
            />
          )}
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
                {f.occupants.has(w.id) ? " · has a session" : ""}
                {(() => {
                  const i = f.issueOf(w);
                  return i ? ` · #${i.number}` : "";
                })()}
              </option>
            ))}
            <option value={NEW} disabled={f.hostCheckouts.length === 0}>
              New worktree…
            </option>
          </select>
          {(f.hostIds.length > 1 || (!!f.project?.catalog && f.hostIds.length > 0)) && (
            <>
              <label htmlFor={`${id}-host`} className="sr-only">
                Host
              </label>
              <select
                id={`${id}-host`}
                className={CHIP_SELECT}
                value={f.hostId}
                disabled={preparingCheckout}
                onChange={(e) => f.changeHost(e.target.value)}
              >
                {f.hostIds.map((h) => (
                  <option key={h} value={h}>
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
                disabled={reuse}
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
        {f.occupant && (
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <p className="text-muted">
              This branch already has a session:{" "}
              <span className="text-text">{f.occupant.title}</span>.
            </p>
            <Checkbox
              data-testid="another-session"
              label="Start another session in this branch"
              checked={f.another}
              onChange={f.setAnother}
            />
          </div>
        )}
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
                  disabled={reuse}
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
        {where && f.hostId && (where.kind === "client" || where.id !== f.hostId) && (
          <p data-testid="new-session-where" className="text-xs text-muted">
            {where.kind === "client"
              ? `This new session won’t run in ${whereLabel(where, hostsById)}. Clear the run location filter to see it.`
              : `This new session won’t run on ${whereLabel(where, hostsById)}. Clear the run location filter to see it.`}
          </p>
        )}
        {leaves && scope && (
          <p data-testid="new-session-leaves" className="text-xs text-muted">
            This session has no issue: it leaves {scope.name} when it stops.{" "}
            {Object.values(issues).some(
              (item) =>
                item.scopeId === scope.id && item.projectId === f.projectId && issueUnstarted(item),
            )
              ? "To keep it, choose From an issue."
              : "Pin it from its menu to keep it."}
          </p>
        )}
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

  const issueProblem = !selectedIssue
    ? "Choose an issue."
    : selectedIssue.sessionId
      ? null
      : action?.kind === "none"
        ? action.label
        : selectedIssue.locator.kind === "repository" && inventory.loading
          ? "Refreshing repository issues…"
          : !f.project || f.projectId !== selectedIssue.projectId
            ? "Choose a project."
            : f.placementProblem;
  const problem = launchMode === "issue" ? issueProblem : f.problem;
  const repoMode = inventory.kind === "repository";
  const searchLabel = repoMode ? "Search repository issues" : "Search tracked issues";
  const entryProject = projectsById[explicitProjectId ?? projectId ?? ""];
  const explicitBrowse = entryProject && githubRepository(entryProject);
  const close = () => {
    if (!inFlight.current && !preparingCheckout) onClose();
  };
  const changeMode = (mode: "prompt" | "issue") => {
    if (inFlight.current || preparingCheckout || mode === launchMode) return;
    if (mode === "issue") promptProject.current = f.projectId;
    else if (promptProject.current) f.setProjectId(promptProject.current);
    setLaunchMode(mode);
    setStoredMode(mode);
    setError(null);
  };
  const body = (
    <div className="space-y-4">
      <fieldset aria-label="New session mode" className="flex gap-2">
        <Button
          type="button"
          variant={launchMode === "prompt" ? "primary" : "secondary"}
          aria-pressed={launchMode === "prompt"}
          disabled={preparingCheckout}
          onClick={() => changeMode("prompt")}
        >
          Write a prompt
        </Button>
        <Button
          type="button"
          variant={launchMode === "issue" ? "primary" : "secondary"}
          aria-pressed={launchMode === "issue"}
          disabled={preparingCheckout}
          onClick={() => changeMode("issue")}
        >
          From an issue
        </Button>
      </fieldset>
      {launchMode === "prompt" ? (
        promptBody
      ) : (
        <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
          <div hidden={!!selectedIssue} className="space-y-3">
            {explicitProjectId ? (
              <div className="space-y-1 text-sm">
                <p>Repository: {entryProject?.name ?? "Unavailable project"}</p>
                <button
                  type="button"
                  className="text-accent"
                  onClick={() => {
                    setExplicitProjectId(null);
                    setIssueId(null);
                    setError(null);
                  }}
                >
                  {scope ? `Return to ${scope.name}` : "Choose another repository"}
                </button>
              </div>
            ) : (
              <ScopeRepository
                scope={scope}
                projects={f.projects}
                projectId={repositoryId}
                onProjectChange={(value) => {
                  setRepositoryId(value);
                  setIssueId(null);
                  setInstruction("");
                }}
              />
            )}
            {explicitBrowse && !explicitProjectId && !repoMode && (
              <button
                type="button"
                className="text-sm text-accent"
                onClick={() => {
                  setExplicitProjectId(entryProject.id);
                  setIssueId(null);
                  setTrackedPreview(false);
                  setError(null);
                }}
              >
                Browse repository issues
              </button>
            )}
            <InventoryStatus inventory={inventory} />
            <TextInput
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flex gap-2">
              <label className="text-sm" htmlFor={`${id}-subset`}>
                Show{" "}
                <Select
                  id={`${id}-subset`}
                  value={subset}
                  onChange={(e) => setSubset(e.target.value as "notStarted" | "all")}
                >
                  <option value="notStarted">Not started</option>
                  <option value="all">{repoMode ? "All open issues" : "All tracked issues"}</option>
                </Select>
              </label>
              <label className="text-sm" htmlFor={`${id}-sort`}>
                Sort{" "}
                <Select
                  id={`${id}-sort`}
                  value={repoMode ? "number" : sort}
                  onChange={(e) => setSort(e.target.value as "number" | "priority")}
                >
                  <option value="number">Repository and number</option>
                  {!repoMode && <option value="priority">Source priority</option>}
                </Select>
              </label>
            </div>
            {inventory.items.length ? (
              <IssueList
                label={repoMode ? "Repository issues" : "Tracked issues"}
                items={inventory.items}
                selectedId={issueId}
                onInspect={(id) => {
                  issueOrigin.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setIssueId(id);
                  setInstruction("");
                  setError(null);
                }}
                showRepo={!issueProjectId}
              />
            ) : (
              <InventoryEmpty
                inventory={inventory}
                filtered={
                  !!query.trim() || (subset === "notStarted" && inventory.allItems.length > 0)
                }
                onNavigate={close}
              />
            )}
            <InventoryMore inventory={inventory} />
          </div>
          {selectedIssue && (
            <>
              <Button
                ref={issueBack}
                type="button"
                size="sm"
                variant="ghost"
                disabled={submitting || preparingCheckout}
                onClick={() => {
                  setIssueId(null);
                  setTrackedPreview(false);
                  setInstruction("");
                  setError(null);
                }}
              >
                Back to issues
              </Button>
              {repoMode && inventory.error != null && <InventoryStatus inventory={inventory} />}
              <IssuePreview
                locator={selectedIssue.locator}
                issue={selectedIssue.issue}
                branchName={selectedIssue.branchName}
                sessionId={selectedIssue.sessionId}
              />
              <p className="text-xs text-muted">{action?.consequences.join(" · ")}</p>
              <label className="block text-sm" htmlFor={`${id}-instruction`}>
                Optional instruction{" "}
                <TextArea
                  id={`${id}-instruction`}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  minRows={3}
                />
              </label>
              {issueCollision && (
                <p role="alert" className="text-sm text-warning">
                  This session already has a draft. Copy or clear your instruction before opening
                  it.
                </p>
              )}
              {!selectedIssue.sessionId && (
                <div className="flex flex-wrap gap-2">
                  {(f.hostIds.length > 1 || (!!f.project?.catalog && f.hostIds.length > 0)) && (
                    <label className="text-sm" htmlFor={`${id}-issue-host`}>
                      Host{" "}
                      <Select
                        id={`${id}-issue-host`}
                        value={f.hostId}
                        disabled={preparingCheckout}
                        onChange={(e) => f.changeHost(e.target.value)}
                      >
                        {f.hostIds.map((host) => (
                          <option key={host} value={host}>
                            {f.hosts[host]?.name ?? "Removed host"}
                            {hostOnline(f.hosts[host]) ? "" : " (offline)"}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  {f.profiles.length > 0 && (
                    <label className="text-sm" htmlFor={`${id}-issue-profile`}>
                      Pi profile{" "}
                      <Select
                        id={`${id}-issue-profile`}
                        value={f.profileId}
                        onChange={(e) => f.setProfileId(e.target.value)}
                      >
                        <option value="">Project default</option>
                        {f.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                </div>
              )}
            </>
          )}
          {errorBox}
        </form>
      )}
      {f.project?.catalog?.state === "listed" &&
        (f.needsCheckout || preparingCheckout) &&
        (launchMode === "prompt" ||
          (!!selectedIssue &&
            selectedIssue.projectId === f.projectId &&
            !selectedIssue.sessionId &&
            !selectedIssue.merged)) && (
          <CheckoutPrepare
            key={JSON.stringify([f.project.id, f.hostId])}
            project={f.project}
            host={f.host}
            hasCheckout={!!f.checkout}
            attachFallback
            onBusyChange={setPreparingCheckout}
          />
        )}
    </div>
  );

  const footer = (
    <>
      {problem ? (
        <p
          role="status"
          aria-live="polite"
          className="mr-auto flex min-w-0 flex-1 basis-full items-start gap-1 text-xs text-muted sm:basis-auto"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {problem}
        </p>
      ) : !mobile && launchMode === "prompt" ? (
        <span className="mr-auto text-xs text-subtle">
          {shortcut} to {reuse ? "open" : "start"}
        </span>
      ) : null}
      <Button onClick={close} disabled={submitting || preparingCheckout}>
        Cancel
      </Button>
      <Button
        variant="primary"
        busy={submitting}
        disabled={!!problem || preparingCheckout || (launchMode === "issue" && issueCollision)}
        onClick={() => void create()}
      >
        {launchMode === "issue"
          ? action?.kind === "open" || action?.kind === "start"
            ? action.label
            : "Start session"
          : reuse
            ? "Open session"
            : "Start session"}
      </Button>
    </>
  );

  if (!mobile) {
    return (
      <Dialog
        open={open}
        onClose={close}
        title="New session"
        dismissOnBackdrop={!submitting && !preparingCheckout}
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
      onClose={close}
      title="New session"
      dismissOnBackdrop={!submitting && !preparingCheckout}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
