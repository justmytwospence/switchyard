import {
  DEFAULT_TASK_POLICY,
  GitHubIssueUrl,
  githubIssueFromUrl,
  type Priority,
  type Task,
  type TaskPolicy,
} from "@switchyard/protocol";
import { ChevronDown, ChevronRight, Inbox, Play } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Field } from "../../components/ui/Field";
import { PrioritySelect } from "../../components/ui/Priority";
import { Select } from "../../components/ui/Select";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { errorMessage } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { CONTINUATION_BUDGET_HELP } from "../settings/policyLogic";
import { createTask, fetchEligibility } from "./api";
import { eligibilityText, isRunActive, parentCandidates, previewEligibility } from "./logic";
import { DependencyPicker, EligibilityNote, ParentPicker } from "./TaskDetail";

const DRAFT_KEY = "sy:new-task-draft";

interface Draft {
  title: string;
  githubIssueUrl: string;
  objective: string;
  projectId: string;
  advanced: boolean;
  priority: Priority;
  dependencies: string[];
  parentTaskId: string;
  hostId: string;
  profileId: string;
  branch: string;
  criteria: string;
  continuation: boolean;
  contObjective: string;
  maxContinuations: string;
  maxMinutes: string;
  maxTokens: string;
  maxCost: string;
  checks: string;
  checksMode: "default" | "custom";
  humanReview: boolean;
}

function emptyDraft(projectId: string): Draft {
  return {
    title: "",
    githubIssueUrl: "",
    objective: "",
    projectId,
    advanced: false,
    priority: 2,
    dependencies: [],
    parentTaskId: "",
    hostId: "",
    profileId: "",
    branch: "",
    criteria: "",
    continuation: false,
    contObjective: "",
    maxContinuations: "3",
    maxMinutes: "60",
    maxTokens: "",
    maxCost: "",
    checks: "",
    checksMode: "default",
    humanReview: true,
  };
}

function loadDraft(projectId: string): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) return { ...emptyDraft(projectId), ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    /* ignore corrupt drafts */
  }
  return emptyDraft(projectId);
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Validate and build the policy; returns field errors when invalid. */
export function buildPolicy(d: Draft): {
  policy: Partial<TaskPolicy>;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const policy: Partial<TaskPolicy> = {};
  const issueMode = !!d.githubIssueUrl.trim();
  if (d.hostId) policy.hostId = d.hostId;
  if (d.profileId) policy.profileId = d.profileId;
  if (d.branch.trim())
    policy.workspace = { mode: "new_worktree", branch: d.branch.trim(), base: null };
  if (issueMode) {
    policy.continuation = { ...DEFAULT_TASK_POLICY.continuation, enabled: false };
  } else if (d.continuation) {
    const max = Number(d.maxContinuations);
    const minutes = Number(d.maxMinutes);
    const tokens = d.maxTokens.trim() ? Number(d.maxTokens) : null;
    const cost = d.maxCost.trim() ? Number(d.maxCost) : null;
    if (!d.contObjective.trim()) errors.contObjective = "Continuation needs an objective.";
    if (!Number.isInteger(max) || max < 1 || max > 50) errors.maxContinuations = "Use 1 to 50.";
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      errors.maxMinutes = "Use 1 to 1440 minutes.";
    if (tokens !== null && (!Number.isInteger(tokens) || tokens <= 0))
      errors.maxTokens = "Use a positive whole number.";
    if (cost !== null && (!Number.isFinite(cost) || cost <= 0))
      errors.maxCost = "Use a positive amount.";
    policy.continuation = {
      enabled: true,
      objective: d.contObjective.trim(),
      maxContinuations: max,
      maxElapsedMinutes: minutes,
      maxTokens: tokens,
      maxCostUsd: cost,
    };
  }
  if (issueMode || d.checksMode === "custom" || !d.humanReview) {
    policy.completion = {
      checks: d.checksMode === "custom" ? lines(d.checks) : null,
      requireHumanReview: issueMode || d.humanReview,
    };
  }
  return { policy, errors };
}

export function NewTaskForm({
  defaultProjectId,
  onCreated,
  onCancel,
}: {
  defaultProjectId: string | null;
  onCreated: (task: Task) => void;
  onCancel: () => void;
}) {
  const projects = useProjects();
  const hosts = useHosts();
  const profiles = useSyncStore((s) => s.profiles);
  const tasks = useSyncStore((s) => s.tasks);
  const runs = useSyncStore((s) => s.runs);
  const hostsById = useSyncStore((s) => s.hosts);
  const paused = useSyncStore((s) => s.dispatchPaused);
  const [d, setD] = useState<Draft>(() => loadDraft(defaultProjectId ?? projects[0]?.id ?? ""));
  const [busy, setBusy] = useState<"backlog" | "ready" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const id = useId();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!d.projectId && projects[0]) setD((x) => ({ ...x, projectId: projects[0]!.id }));
  }, [d.projectId, projects]);
  useEffect(() => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  }, [d]);

  const issueMode = !!d.githubIssueUrl.trim();
  const parsedIssue = GitHubIssueUrl.safeParse(d.githubIssueUrl);
  const issue = parsedIssue.success ? githubIssueFromUrl(parsedIssue.data) : null;
  const project = projects.find((p) => p.id === d.projectId);
  const defaultHost = project?.defaultHostId ? hostsById[project.defaultHostId] : undefined;
  const defaultProfile = project?.defaultProfileId ? profiles[project.defaultProfileId] : undefined;
  const candidates = Object.values(tasks)
    .filter((t) => t.projectId === d.projectId && t.state !== "canceled" && !t.hiddenFromBoard)
    .sort((a, b) => a.title.localeCompare(b.title));

  const parents = parentCandidates(d.projectId, tasks);

  const preview = useMemo(() => {
    const runningByProject: Record<string, number> = {};
    for (const r of Object.values(runs)) {
      if (!isRunActive(r)) continue;
      const p = tasks[r.taskId]?.projectId;
      if (p) runningByProject[p] = (runningByProject[p] ?? 0) + 1;
    }
    return previewEligibility(
      { project, hostId: d.hostId || null, dependencies: d.dependencies },
      { hosts: hostsById, tasks, dispatchPaused: paused, runningByProject },
    );
  }, [project, d.hostId, d.dependencies, hostsById, tasks, runs, paused]);

  const submit = async (state: "backlog" | "ready") => {
    const errs: Record<string, string> = {};
    if (!issueMode && !d.title.trim()) errs.title = "Give the task a title.";
    if (issueMode && !parsedIssue.success)
      errs.githubIssueUrl =
        "Use https://github.com/OWNER/REPO/issues/NUMBER with no query or fragment.";
    if (!project) errs.projectId = "Choose a project.";
    if (d.parentTaskId && !parents.some((t) => t.id === d.parentTaskId))
      errs.parentTaskId = "Choose a parent in this project, or None.";
    const { policy, errors: pErr } = buildPolicy(d);
    Object.assign(errs, pErr);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      if (Object.keys(pErr).length > 0) set("advanced", true);
      return;
    }
    setBusy(state);
    setSubmitError(null);
    try {
      const task = await createTask({
        projectId: d.projectId,
        title: d.title.trim(),
        ...(issueMode ? { githubIssueUrl: d.githubIssueUrl } : {}),
        objective: issueMode ? "" : d.objective,
        acceptanceCriteria: issueMode ? [] : lines(d.criteria),
        dependencies: d.dependencies,
        parentTaskId: d.parentTaskId || null,
        priority: d.priority,
        state,
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
      });
      sessionStorage.removeItem(DRAFT_KEY);
      if (state === "ready") {
        let msg = eligibilityText(preview);
        try {
          msg = eligibilityText(await fetchEligibility(task.id));
        } catch {
          /* keep the local estimate */
        }
        toast.success(`Created "${task.title}" in Ready. ${msg}.`);
      } else {
        toast.success(`Created "${task.title}" in Backlog.`);
      }
      onCreated(task);
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      data-testid="new-task-form"
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("backlog");
      }}
    >
      <Field
        id={`${id}-issue`}
        label="GitHub issue URL"
        hint="Optional. The first run sends only the issue link and a gh issue view instruction, with continuation off and human review required."
        error={errors.githubIssueUrl}
      >
        {(p) => (
          <TextInput
            {...p}
            value={d.githubIssueUrl}
            onChange={(e) => set("githubIssueUrl", e.target.value)}
            placeholder="https://github.com/OWNER/REPO/issues/17"
          />
        )}
      </Field>
      <Field
        id={`${id}-title`}
        label="Title"
        hint={
          issueMode
            ? "Optional for issue imports; leave blank to use the issue reference."
            : undefined
        }
        error={errors.title}
      >
        {(p) => (
          <TextInput
            {...p}
            value={d.title}
            autoFocus
            onChange={(e) => set("title", e.target.value)}
            placeholder={issue ? `${issue.repository} #${issue.number}` : "What should be done?"}
            maxLength={300}
          />
        )}
      </Field>
      {!issueMode && (
        <Field id={`${id}-objective`} label="Objective">
          <TextArea
            id={`${id}-objective`}
            minRows={3}
            maxHeight="35vh"
            value={d.objective}
            onChange={(e) => set("objective", e.target.value)}
            placeholder="Context, constraints and what done looks like"
          />
        </Field>
      )}
      <Field id={`${id}-project`} label="Project" error={errors.projectId}>
        {(p) => (
          <Select
            {...p}
            value={d.projectId}
            onChange={(e) =>
              setD((x) => ({
                ...x,
                projectId: e.target.value,
                dependencies: [],
                parentTaskId: "",
              }))
            }
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <ParentPicker
        candidates={parents}
        value={d.parentTaskId}
        onChange={(v) => set("parentTaskId", v)}
        error={errors.parentTaskId}
      />

      <div>
        <TextLink
          size="sm"
          aria-expanded={d.advanced}
          aria-controls={`${id}-adv`}
          icon={
            d.advanced ? (
              <ChevronDown aria-hidden className="size-4" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )
          }
          onClick={() => set("advanced", !d.advanced)}
        >
          Advanced options
        </TextLink>
        <p className="text-xs text-muted">Unset options inherit the project defaults.</p>
      </div>

      {d.advanced && (
        <div id={`${id}-adv`} className="flex flex-col gap-4 rounded-lg border border-border p-3">
          <Field id={`${id}-prio`} label="Priority">
            {(p) => (
              <PrioritySelect {...p} value={d.priority} onChange={(v) => set("priority", v)} />
            )}
          </Field>
          {!issueMode && (
            <Field id={`${id}-criteria`} label="Acceptance criteria (one per line)">
              <TextArea
                id={`${id}-criteria`}
                minRows={2}
                maxHeight="25vh"
                value={d.criteria}
                onChange={(e) => set("criteria", e.target.value)}
              />
            </Field>
          )}
          <DependencyPicker
            candidates={candidates}
            value={d.dependencies}
            onChange={(v) => set("dependencies", v)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-host`} label="Host">
              <Select
                id={`${id}-host`}
                value={d.hostId}
                onChange={(e) => set("hostId", e.target.value)}
              >
                <option value="">
                  Project default{defaultHost ? ` (${defaultHost.name})` : ""}
                </option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                    {h.connectivity !== "connected" ? " (offline)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={`${id}-profile`} label="Pi profile">
              <Select
                id={`${id}-profile`}
                value={d.profileId}
                onChange={(e) => set("profileId", e.target.value)}
              >
                <option value="">
                  Project default{defaultProfile ? ` (${defaultProfile.name})` : ""}
                </option>
                {Object.values(profiles).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            id={`${id}-branch`}
            label="Branch"
            hint="Work happens in a new worktree on this branch."
          >
            {(p) => (
              <TextInput
                {...p}
                value={d.branch}
                placeholder="Generated from the title"
                onChange={(e) => set("branch", e.target.value)}
              />
            )}
          </Field>

          {!issueMode && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Continuation limits</legend>
              <Checkbox
                label="Continue automatically until done (off by default)"
                checked={d.continuation}
                onChange={(on) => set("continuation", on)}
              />
              {d.continuation && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    id={`${id}-cobj`}
                    label="Continuation objective"
                    error={errors.contObjective}
                    className="sm:col-span-2"
                  >
                    {(p) => (
                      <TextInput
                        {...p}
                        value={d.contObjective}
                        onChange={(e) => set("contObjective", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    id={`${id}-cmax`}
                    label="Max continuations"
                    error={errors.maxContinuations}
                  >
                    {(p) => (
                      <TextInput
                        {...p}
                        inputMode="decimal"
                        value={d.maxContinuations}
                        onChange={(e) => set("maxContinuations", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field id={`${id}-cmin`} label="Max minutes" error={errors.maxMinutes}>
                    {(p) => (
                      <TextInput
                        {...p}
                        inputMode="decimal"
                        value={d.maxMinutes}
                        onChange={(e) => set("maxMinutes", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    id={`${id}-ctok`}
                    label="Continuation budget: tokens (optional)"
                    error={errors.maxTokens}
                  >
                    {(p) => (
                      <TextInput
                        {...p}
                        inputMode="decimal"
                        value={d.maxTokens}
                        onChange={(e) => set("maxTokens", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    id={`${id}-ccost`}
                    label="Continuation budget: cost USD (optional)"
                    error={errors.maxCost}
                  >
                    {(p) => (
                      <TextInput
                        {...p}
                        inputMode="decimal"
                        value={d.maxCost}
                        onChange={(e) => set("maxCost", e.target.value)}
                      />
                    )}
                  </Field>
                  <p className="text-xs text-muted sm:col-span-2">{CONTINUATION_BUDGET_HELP}</p>
                </div>
              )}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Checks and review</legend>
            <Checkbox
              label={
                <>
                  Use custom checks instead of the project's
                  {project?.checks.length ? ` (${project.checks.join(", ")})` : " (none)"}
                </>
              }
              checked={d.checksMode === "custom"}
              onChange={(on) => set("checksMode", on ? "custom" : "default")}
            />
            {d.checksMode === "custom" && (
              <Field
                id={`${id}-checks`}
                label="Check commands (one per line; empty means no checks)"
              >
                <TextArea
                  id={`${id}-checks`}
                  minRows={2}
                  className="font-mono"
                  value={d.checks}
                  onChange={(e) => set("checks", e.target.value)}
                />
              </Field>
            )}
            {issueMode ? (
              <p className="text-xs text-muted">Issue imports require human review before Done.</p>
            ) : (
              <Checkbox
                label="Require human review before Done"
                checked={d.humanReview}
                onChange={(on) => set("humanReview", on)}
              />
            )}
          </fieldset>
        </div>
      )}

      {submitError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm">
          Could not create the task: {submitError}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <EligibilityNote e={preview} prefix="Make ready: " />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            icon={<Inbox className="size-4" />}
            busy={busy === "backlog"}
            disabled={busy !== null}
          >
            Save to Backlog
          </Button>
          <Button
            variant="primary"
            icon={<Play className="size-4" />}
            busy={busy === "ready"}
            disabled={busy !== null}
            onClick={() => void submit("ready")}
          >
            Make ready
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted">
          Make ready authorizes dispatch. Nothing starts until the coordinator confirms.
        </p>
      </div>
    </form>
  );
}
