import {
  issueBranchSet,
  issueBranchSetHas,
  issueLookup,
  primarySession,
  type Scope,
  type Session,
} from "@switchyard/protocol";
import { ChevronDown, ChevronRight, GitBranch, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Field } from "../../components/ui/Field";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { ErrorState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { loadDraft, setDraftNow } from "../../drafts";
import { useFilter, usePrefs } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useProjects, useSyncStore } from "../../sync/store";
import { IssueList } from "../discovery/IssueList";
import { IssuePreview } from "../discovery/IssuePreview";
import { issueAction } from "../discovery/issueAction";
import { discoveryContext, issueInventory } from "../discovery/model";
import { ScopeRepository } from "../discovery/ScopeRepository";
import { describeDiscoverySource } from "../scopes/describe";
import { effectiveWhere, useSelectedWhere, whereLabel } from "../scopes/where";
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
  /** The host to start on when the project has a checkout there and it is online (a host Where). */
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
    const prefer = preferHostId && hostOnline(hosts[preferHostId]) ? preferHostId : undefined;
    const d = newSessionDefaults(project, projectCheckouts, projectWorkspaces, hosts, prefer);
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
  else if (mode !== "existing" && !checkout)
    problem = `No checkout of ${project.name} on ${host.name}.`;
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
  initialIssueId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  mobile: boolean;
  projectId?: string | null;
  initialMode?: "prompt" | "issue";
  initialIssueId?: string;
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
  const inFlight = useRef(false);
  const promptProject = useRef<string | null>(null);
  const issueBack = useRef<HTMLButtonElement>(null);
  const issueOrigin = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [storedMode, setStoredMode] = useFilter<"prompt" | "issue">("new-session-mode", "prompt");
  const [launchMode, setLaunchMode] = useState<"prompt" | "issue">("prompt");
  const [issueId, setIssueId] = useState<string | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [outside, setOutside] = useState(false);
  const [query, setQuery] = useState("");
  const [subset, setSubset] = useState<"notStarted" | "all">("notStarted");
  const [sort, setSort] = useFilter<"number" | "priority">("discovery-sort", "number");
  const [instruction, setInstruction] = useState("");
  const [overrideDestination, setOverrideDestination] = useState(false);
  const projectsById = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const checkouts = useSyncStore((s) => s.checkouts);
  const hydrated = useSyncStore((s) => s.hydrated);
  const context = discoveryContext(scope, f.projects);
  const issueProjectId = (outside ? projectId : repositoryId) ?? context.fixedProjectId;
  const inventory = useMemo(
    () =>
      issueInventory(
        { projects: projectsById, issues, workspaces, sessions, scopes: knownScopes },
        {
          scope: outside ? null : scope,
          projectId: issueProjectId,
          query: "",
          subset: "all",
          sort,
        },
      ),
    [projectsById, issues, workspaces, sessions, knownScopes, outside, scope, issueProjectId, sort],
  );
  const visibleIssues = useMemo(
    () =>
      issueInventory(
        { projects: projectsById, issues, workspaces, sessions, scopes: knownScopes },
        {
          scope: outside ? null : scope,
          projectId: issueProjectId,
          query,
          subset,
          sort,
        },
      ),
    [
      projectsById,
      issues,
      workspaces,
      sessions,
      knownScopes,
      outside,
      scope,
      issueProjectId,
      query,
      subset,
      sort,
    ],
  );
  const selectedIssue = inventory.find((item) => item.id === issueId);
  const action = selectedIssue
    ? issueAction(selectedIssue, {
        instruction,
        hostId: f.hostId,
        profileId: f.profileId,
        hosts: hostsById,
        checkouts,
        scopes: knownScopes,
      })
    : null;
  const source = describeDiscoverySource(
    outside ? null : scope,
    projectsById[issueProjectId ?? ""] ?? null,
    knownScopes,
  );
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
    setIssueId(initialIssueId ?? null);
    setRepositoryId(
      projectId &&
        (!scope ||
          (scope.mode !== "pinned" &&
            (scope.projectIds === null || scope.projectIds.includes(projectId))))
        ? projectId
        : null,
    );
    setOutside(false);
    setQuery("");
    setSubset(initialIssueId ? "all" : "notStarted");
    setInstruction("");
    setOverrideDestination(
      !!projectId && !!context.fixedProjectId && projectId !== context.fixedProjectId,
    );
  }, [open, initialMode, initialIssueId, projectId, selectedScope]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && hydrated && issueId && !selectedIssue) {
      setIssueId(null);
      setInstruction("");
      toast.error("That issue is no longer available in this scope.");
    }
  }, [open, hydrated, issueId, selectedIssue]);

  const inspectedId = selectedIssue?.id;
  useEffect(() => {
    if (!open || launchMode !== "issue") return;
    if (inspectedId) issueBack.current?.focus();
    else issueOrigin.current?.focus();
  }, [open, launchMode, inspectedId]);

  // A selected tracked issue determines the launch destination, independently of workspace resets.
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
    if (inFlight.current) return;
    if (launchMode === "issue") {
      const state = useSyncStore.getState();
      const freshScope = selectedScope ? state.scopes[selectedScope] : null;
      if (!outside && selectedScope && !freshScope) return;
      const fresh = issueInventory(state, {
        scope: outside ? null : (freshScope ?? null),
        projectId: issueProjectId,
        query: "",
        subset: "all",
        sort,
      }).find((item) => item.id === issueId);
      if (!fresh || (fresh.merged && !fresh.sessionId)) return;
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
        hosts: hostsById,
        checkouts,
        scopes: knownScopes,
      });
      if (freshAction.kind !== "start") return;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const result = await openIssue(freshAction.issueId, freshAction.request);
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
                onClick={() => setOverrideDestination(true)}
              >
                Choose a different repository
              </button>
            </>
          ) : (
            <ProjectPicker projects={f.projects} value={f.projectId} onChange={f.setProjectId} />
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
            {inventory.some((item) => item.projectId === f.projectId && item.notStarted)
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
    ? "Choose a tracked issue."
    : selectedIssue.sessionId
      ? null
      : selectedIssue.merged
        ? "This issue is merged."
        : !f.project
          ? "Choose a project."
          : f.hostIds.length === 0
            ? "This project has no checkout yet. Add one in Settings › Projects."
            : !f.host
              ? "Choose a host."
              : !hostOnline(f.host)
                ? `${f.host.name} is offline.`
                : !f.host.piCompatible
                  ? `Pi ${f.host.piVersion ?? "(not found)"} on ${f.host.name} is outside the tested range.`
                  : !f.checkout
                    ? `No checkout of ${f.project.name} on ${f.host.name}.`
                    : null;
  const problem = launchMode === "issue" ? issueProblem : f.problem;
  const emptyIssues = source.emptyState(
    !!query.trim() || (subset === "notStarted" && inventory.length > 0),
  );
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const changeMode = (mode: "prompt" | "issue") => {
    if (inFlight.current || mode === launchMode) return;
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
          onClick={() => changeMode("prompt")}
        >
          Write a prompt
        </Button>
        <Button
          type="button"
          variant={launchMode === "issue" ? "primary" : "secondary"}
          aria-pressed={launchMode === "issue"}
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
            {outside ? (
              <p className="text-sm">
                Outside {scope?.name}{" "}
                <button
                  type="button"
                  className="text-accent"
                  onClick={() => {
                    setOutside(false);
                    setIssueId(null);
                  }}
                >
                  Return to scope
                </button>
              </p>
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
            {context.coverage === "pins" && !outside && (
              <p className="text-sm text-muted">This scope contains pinned sessions only.</p>
            )}
            {scope &&
              projectId &&
              projectsById[projectId] &&
              !outside &&
              (context.coverage === "pins" ||
                (projectId &&
                  scope.projectIds !== null &&
                  !scope.projectIds.includes(projectId))) && (
                <button
                  type="button"
                  className="text-sm text-accent"
                  onClick={() => {
                    setOutside(true);
                    setIssueId(null);
                  }}
                >
                  Browse tracked issues in this repo
                </button>
              )}
            <div className="space-y-1 text-xs text-muted">
              <p>{source.summary}</p>
              {source.sources.map((s) => (
                <p key={s.id}>
                  {s.name}: {s.description}
                  {s.lastError
                    ? ` · ${s.lastError}`
                    : s.lastSyncedAt
                      ? ` · Last sync ${s.lastSyncedAt}`
                      : ""}
                </p>
              ))}
              {source.openIssuesUrl && (
                <a
                  className="text-accent"
                  href={source.openIssuesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View all open issues on GitHub
                </a>
              )}
            </div>
            <TextInput
              aria-label="Search tracked issues"
              placeholder="Search tracked issues"
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
                  <option value="all">All tracked issues</option>
                </Select>
              </label>
              <label className="text-sm" htmlFor={`${id}-sort`}>
                Sort{" "}
                <Select
                  id={`${id}-sort`}
                  value={sort}
                  onChange={(e) => setSort(e.target.value as "number" | "priority")}
                >
                  <option value="number">Repository and number</option>
                  <option value="priority">Source priority</option>
                </Select>
              </label>
            </div>
            {visibleIssues.length ? (
              <IssueList
                items={visibleIssues}
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
              <div className="space-y-1 text-sm">
                <p className="font-medium">{emptyIssues.title}</p>
                <p className="text-muted">{emptyIssues.description}</p>
                {emptyIssues.action && (
                  <Link
                    className="text-accent hover:underline"
                    to={emptyIssues.action.to}
                    onClick={close}
                  >
                    {emptyIssues.action.label}
                  </Link>
                )}
              </div>
            )}
          </div>
          {selectedIssue && (
            <>
              <Button
                ref={issueBack}
                type="button"
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  setIssueId(null);
                  setInstruction("");
                  setError(null);
                }}
              >
                Back to issues
              </Button>
              <IssuePreview
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
                  {f.hostIds.length > 1 && (
                    <label className="text-sm" htmlFor={`${id}-issue-host`}>
                      Host{" "}
                      <Select
                        id={`${id}-issue-host`}
                        value={f.hostId}
                        onChange={(e) => f.changeHost(e.target.value)}
                      >
                        {f.hostIds.map((host) => (
                          <option key={host} value={host} disabled={!hostOnline(f.hosts[host])}>
                            {f.hosts[host]?.name ?? "Removed host"}
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
      <Button onClick={close} disabled={submitting}>
        Cancel
      </Button>
      <Button
        variant="primary"
        busy={submitting}
        disabled={!!problem || (launchMode === "issue" && issueCollision)}
        onClick={() => void create()}
      >
        {launchMode === "issue"
          ? (action?.label ?? "Start session")
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
      onClose={close}
      title="New session"
      dismissOnBackdrop={!submitting}
      footer={footer}
    >
      {body}
    </Sheet>
  );
}
