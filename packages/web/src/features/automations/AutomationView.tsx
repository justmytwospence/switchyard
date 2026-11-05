import { Automation, PRIORITY_LABELS, type Priority } from "@switchyard/protocol";
import {
  ArrowLeft,
  CalendarClock,
  CircleDot,
  Play,
  Plus,
  Save,
  Trash,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { backLinkClick, useBackTo } from "../../app/useBackTo";
import { useBreakpoint } from "../../app/useBreakpoint";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, FieldError } from "../../components/ui/Field";
import { IconButton } from "../../components/ui/IconButton";
import { Dialog } from "../../components/ui/Overlay";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Select } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import {
  EmptyState,
  ErrorState,
  FatalError,
  HostUnavailable,
  LoadingState,
} from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import {
  automationPath,
  ConnectionNote,
  PriorityIcon,
  useLocalAutomations,
  useMergedAutomation,
  useRunNow,
} from "./controls";
import {
  type AutomationDraft,
  type DraftErrors,
  type DraftField,
  describeCron,
  draftFromAutomation,
  draftToInput,
  emptyDraft,
  fieldForPath,
  localInputToIso,
  localTimezone,
  MISSED_OPTIONS,
  MODE_OPTIONS,
  OVERLAP_OPTIONS,
  summarizeAutomation,
  TEMPLATE_VARIABLES,
  TRIGGER_KIND_LABELS,
  type TriggerKind,
  validateCron,
  validateDraft,
} from "./describe";
import { HistorySection, PreviewPanel, SummaryPanel, WebhookSection } from "./panels";

const LIST_PATH = "/automations";
const editPath = (id: string) => `/automations/${encodeURIComponent(id)}`;
const DRAFT_KEY = "sy:automation-draft";

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "notfound" }
  | { status: "error"; error: unknown }
  | { status: "fatal"; error: unknown };

/** Route /automations/:automationId (and /automations/new). */
export default function AutomationView() {
  const { automationId = "new" } = useParams();
  return <AutomationRoute key={automationId} automationId={automationId} />;
}

function AutomationRoute({ automationId }: { automationId: string }) {
  const isNew = automationId === "new";
  const hydrated = useSyncStore((s) => s.hydrated);
  const automation = useMergedAutomation(isNew ? undefined : automationId);
  const [load, setLoad] = useState<LoadState>({ status: "idle" });

  const fetchOne = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const res = await apiGet<unknown>(automationPath(automationId));
      const parsed = Automation.safeParse(res);
      if (!parsed.success) {
        setLoad({
          status: "fatal",
          error: new Error("The coordinator returned this automation in an unexpected format."),
        });
        return;
      }
      useLocalAutomations.getState().put(parsed.data);
      setLoad({ status: "idle" });
    } catch (e) {
      if (isApiError(e) && e.status === 404) setLoad({ status: "notfound" });
      else setLoad({ status: "error", error: e });
    }
  }, [automationId]);

  const missing = !isNew && !automation;
  useEffect(() => {
    if (missing && load.status === "idle") void fetchOne();
  }, [missing, load.status, fetchOne]);

  if (isNew) return <Editor automation={null} />;
  if (automation) return <Editor automation={automation} />;
  if (load.status === "notfound") {
    return (
      <EmptyState
        icon={<Workflow className="size-8" />}
        title="Automation not found"
        description="It may have been deleted, or the link is wrong."
        action={{ label: "Back to automations", to: LIST_PATH }}
      />
    );
  }
  if (load.status === "error") {
    return (
      <ErrorState
        title="Could not load this automation"
        error={load.error}
        onRetry={() => void fetchOne()}
      />
    );
  }
  if (load.status === "fatal") return <FatalError error={load.error} />;
  return <LoadingState label={hydrated ? "Loading automation…" : "Loading…"} />;
}

/* ------------------------------------------------------------------ */
/* Draft persistence for unsaved new automations                       */
/* ------------------------------------------------------------------ */

function loadNewDraft(projectId: string | undefined): AutomationDraft {
  const base = emptyDraft({ projectId, timezone: localTimezone() });
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<AutomationDraft>;
    if (!saved || typeof saved !== "object") return base;
    return { ...base, ...saved, filters: Array.isArray(saved.filters) ? saved.filters : [] };
  } catch {
    return base;
  }
}

function saveNewDraft(draft: AutomationDraft | null) {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage full or unavailable: the draft stays in memory.
  }
}

const serialize = (d: AutomationDraft) => JSON.stringify(draftToInput(d));

/** Map a server validation error's details onto form fields. */
function serverFieldErrors(e: unknown): DraftErrors {
  if (!isApiError(e)) return {};
  const details = e.details as unknown;
  const issues = Array.isArray(details)
    ? details
    : details &&
        typeof details === "object" &&
        Array.isArray((details as { issues?: unknown }).issues)
      ? (details as { issues: unknown[] }).issues
      : [];
  const out: DraftErrors = {};
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== "string") continue;
    const f = fieldForPath(path as PropertyKey[]);
    if (f !== "form" && !out[f]) out[f] = message;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function Editor({ automation }: { automation: Automation | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const back = useBackTo(LIST_PATH);
  const bp = useBreakpoint();
  const desktop = bp === "desktop";
  const projects = useProjects();
  const hosts = useHosts();
  const hostsById = useSyncStore((s) => s.hosts);
  const profiles = useSyncStore((s) => s.profiles);
  const tasks = useSyncStore((s) => s.tasks);
  const projectsById = useSyncStore((s) => s.projects);
  const isNew = automation === null;
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  const [draft, setDraft] = useState<AutomationDraft>(() =>
    automation ? draftFromAutomation(automation) : loadNewDraft(projects[0]?.id),
  );
  const [baseline, setBaseline] = useState(() => serialize(draft));
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const seenUpdatedAt = useRef(automation?.updatedAt);

  const current = serialize(draft);
  const dirty = current !== baseline;

  // Follow remote updates while the draft is clean; never discard local edits.
  useEffect(() => {
    if (!automation || automation.updatedAt === seenUpdatedAt.current) return;
    seenUpdatedAt.current = automation.updatedAt;
    const next = draftFromAutomation(automation);
    const nextKey = serialize(next);
    if (current === baseline) {
      setDraft(next);
      setRemoteChanged(false);
    } else if (nextKey !== current) {
      setRemoteChanged(true);
    }
    setBaseline(nextKey);
  }, [automation, current, baseline]);

  // Persist the unsaved new-automation draft across navigation and reloads.
  useEffect(() => {
    if (isNew) saveNewDraft(draft);
  }, [isNew, draft]);

  // Default the project once projects arrive.
  useEffect(() => {
    if (isNew && !draft.projectId && projects[0]) {
      setDraft((d) => (d.projectId ? d : { ...d, projectId: projects[0]!.id }));
    }
  }, [isNew, draft.projectId, projects]);

  const update = useCallback(
    <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
      setServerErrors((e) => (Object.keys(e).length ? {} : e));
    },
    [],
  );

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const errors: DraftErrors = { ...serverErrors, ...(showErrors ? validation.errors : {}) };
  const err = (f: DraftField) => errors[f];

  const project = projectsById[draft.projectId];
  const selectedHostId = draft.hostId || project?.defaultHostId || null;
  const selectedHost = selectedHostId ? hostsById[selectedHostId] : undefined;
  const selectedProfileId = draft.profileId || project?.defaultProfileId || null;
  const taskTitle = useCallback((id: string) => tasks[id]?.title, [tasks]);

  const summary = useMemo(
    () =>
      summarizeAutomation(draftToInput(draft), {
        projectName: project?.name,
        hostName: draft.hostId ? (hostsById[draft.hostId]?.name ?? null) : null,
        profileName: draft.profileId ? (profiles[draft.profileId]?.name ?? null) : null,
        taskTitle,
      }),
    [draft, project?.name, hostsById, profiles, taskTitle],
  );

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const getValidInput = () => {
    setShowErrors(true);
    if (!validation.input) focusFirstError();
    return validation.input;
  };

  const save = async () => {
    const input = getValidInput();
    if (!input) {
      toast.error("Fix the highlighted fields before saving");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await apiPost<Automation>("/api/automations", input);
        if (!created || typeof created !== "object" || !created.id) {
          throw new Error("The coordinator did not return the new automation");
        }
        useLocalAutomations.getState().put(created);
        saveNewDraft(null);
        toast.success(`Created ${created.name}`);
        navigate(editPath(created.id), { replace: true, state: location.state });
        return;
      }
      const saved = await apiPatch<Automation>(automationPath(automation.id), input);
      if (saved && typeof saved === "object" && saved.id) {
        useLocalAutomations.getState().put(saved);
        seenUpdatedAt.current = saved.updatedAt;
        const next = draftFromAutomation(saved);
        setDraft(next);
        setBaseline(serialize(next));
      } else {
        setBaseline(current);
      }
      setRemoteChanged(false);
      setShowErrors(false);
      toast.success(`Saved ${input.name}`);
    } catch (e) {
      const fieldErrors = serverFieldErrors(e);
      setServerErrors(fieldErrors);
      if (Object.keys(fieldErrors).length) focusFirstError();
      toast.error(`Could not save: ${errorMessage(e)}. Your changes are kept.`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!automation) return;
    setDeleting(true);
    try {
      await apiDelete(automationPath(automation.id));
      setConfirmDelete(false);
      toast.success(`Deleted ${automation.name}`);
      back();
      useLocalAutomations.getState().remove(automation.id);
    } catch (e) {
      toast.error(`Could not delete: ${errorMessage(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  const { busy: runBusy, run } = useRunNow(() => setHistoryKey((k) => k + 1));
  const running = automation ? !!runBusy[automation.id] : false;
  const runNow = () => automation && void run(automation);

  const discardNew = () => {
    const fresh = emptyDraft({ projectId: projects[0]?.id, timezone: localTimezone() });
    setDraft(fresh);
    setShowErrors(false);
    saveNewDraft(null);
  };

  const title = isNew ? "New automation" : automation.name;

  const actions = (
    <>
      {!isNew && (
        <>
          <Button
            icon={<Play className="size-4" />}
            busy={running}
            onClick={runNow}
            title={dirty ? "Runs the saved version" : undefined}
          >
            Run now
          </Button>
          <Button
            variant="ghost"
            icon={<Trash className="size-4" />}
            onClick={() => setConfirmDelete(true)}
            className="text-danger"
          >
            Delete
          </Button>
        </>
      )}
      {isNew && dirty && (
        <Button variant="ghost" icon={<X className="size-4" />} onClick={discardNew}>
          Discard draft
        </Button>
      )}
    </>
  );

  const saveButton = (block?: boolean) => (
    <Button
      type="submit"
      form={formId}
      variant="primary"
      busy={saving}
      block={block}
      icon={<Save className="size-4" />}
    >
      {isNew ? "Create automation" : "Save"}
    </Button>
  );

  const aside = (
    <>
      <SummaryPanel
        summary={summary}
        errorCount={showErrors ? Object.keys(validation.errors).length : 0}
      />
      <PreviewPanel
        automationId={automation?.id ?? null}
        dirty={dirty}
        getInput={getValidInput}
        currentKey={JSON.stringify(validation.input)}
      />
      {automation && automation.trigger.kind === "webhook" && (
        <WebhookSection automation={automation} />
      )}
      {automation && (
        <HistorySection automationId={automation.id} refreshKey={historyKey} onRun={runNow} />
      )}
    </>
  );

  return (
    <div
      data-testid="automation-editor"
      className="flex w-full min-w-0 flex-col gap-4 px-4 pt-4 md:px-6"
    >
      <header className="flex min-w-0 flex-col gap-2">
        <Link
          to={LIST_PATH}
          onClick={backLinkClick(back)}
          className="tap inline-flex items-center gap-1 self-start rounded text-sm text-muted hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Automations
        </Link>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-lg font-semibold break-words">{title}</h1>
            {dirty && (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <CircleDot aria-hidden className="size-3.5" />
                Unsaved changes
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {desktop && saveButton()}
          </div>
        </div>
      </header>

      <ConnectionNote />
      {selectedHost && selectedHost.connectivity !== "connected" && (
        <HostUnavailable
          compact
          hostName={selectedHost.name}
          connectivity={selectedHost.connectivity}
          lastSeenAt={selectedHost.lastSeenAt}
          detail="Occurrences are still recorded; their tasks wait until the host is reachable."
        />
      )}
      {remoteChanged && (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-md border border-border bg-warning-soft px-3 py-2 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          This automation changed elsewhere. Saving overwrites those changes with yours.
        </p>
      )}

      <div
        className={cn(
          "grid min-w-0 gap-4",
          desktop ? "grid-cols-[minmax(0,1fr)_minmax(320px,400px)] items-start" : "grid-cols-1",
        )}
      >
        <form
          id={formId}
          ref={formRef}
          noValidate
          aria-label={title}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex min-w-0 flex-col gap-4"
        >
          <BasicsSection draft={draft} update={update} err={err} projects={projects} />
          <TriggerSection
            draft={draft}
            update={update}
            err={err}
            tasks={tasks}
            projectsById={projectsById}
            savedAutomation={automation}
            segmented={bp !== "mobile"}
          />
          <FiltersSection draft={draft} setDraft={setDraft} err={err} />
          <TemplateSection draft={draft} update={update} err={err} />
          <ExecutionSection
            draft={draft}
            update={update}
            err={err}
            hosts={hosts}
            profiles={Object.values(profiles).sort((a, b) => a.name.localeCompare(b.name))}
            defaultHostName={
              project?.defaultHostId ? hostsById[project.defaultHostId]?.name : undefined
            }
            defaultProfileName={
              project?.defaultProfileId ? profiles[project.defaultProfileId]?.name : undefined
            }
            selectedProfileMissing={!!selectedProfileId && !profiles[selectedProfileId]}
          />
          <PoliciesSection draft={draft} update={update} />
          <LimitsSection draft={draft} update={update} err={err} />
          <ReviewSection draft={draft} update={update} err={err} projectChecks={project?.checks} />
          {errors.form && <FieldError>{errors.form}</FieldError>}
        </form>
        <aside aria-label="Summary, preview and history" className="flex min-w-0 flex-col gap-4">
          {aside}
        </aside>
      </div>

      {desktop ? (
        <div className="h-4" />
      ) : (
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-border bg-surface px-4 py-2 md:-mx-6 md:px-6">
          <span className="min-w-0 flex-1 truncate text-sm text-muted">
            {dirty ? "Unsaved changes" : isNew ? "Not saved yet" : "All changes saved"}
          </span>
          {saveButton()}
        </div>
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${automation?.name ?? "automation"}?`}
        description="Future occurrences stop. Tasks it already created stay on the board; its history is removed."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={deleting}
              icon={<Trash className="size-4" />}
              onClick={() => void remove()}
            >
              Delete automation
            </Button>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form sections                                                       */
/* ------------------------------------------------------------------ */

type Update = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => void;
type Err = (f: DraftField) => string | undefined;

interface SectionProps {
  draft: AutomationDraft;
  update: Update;
  err: Err;
}

function BasicsSection({
  draft,
  update,
  err,
  projects,
}: SectionProps & { projects: { id: string; name: string }[] }) {
  return (
    <Card stack title="Basics">
      <Field label="Name" error={err("name")}>
        {(p) => (
          <TextInput
            {...p}
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="Daily dependency check"
            autoComplete="off"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Project"
          error={err("projectId")}
          hint={
            projects.length === 0 ? (
              <>
                No projects yet. <Link to="/settings/projects">Add a project in Settings</Link>.
              </>
            ) : undefined
          }
        >
          {(p) => (
            <Select
              {...p}
              value={draft.projectId}
              onChange={(e) => update("projectId", e.target.value)}
            >
              <option value="">Choose a project</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Status"
          hint="Disabled automations keep their history and can still run manually."
        >
          {(p) => (
            <Switch
              {...p}
              checked={draft.enabled}
              onChange={(v) => update("enabled", v)}
              label="Enabled"
              onText="Enabled"
              offText="Disabled"
              className="self-start"
            />
          )}
        </Field>
      </div>
    </Card>
  );
}

const TRIGGER_KINDS: TriggerKind[] = ["manual", "once", "cron", "webhook", "dependency"];

const TRIGGER_HELP: Record<TriggerKind, string> = {
  manual: "Runs only when you press Run now (or from the CLI).",
  once: "Runs a single time at the chosen moment.",
  cron: "Runs on a timezone-aware cron schedule.",
  webhook: "Runs when an authenticated JSON POST arrives at this automation's webhook URL.",
  dependency: "Runs when the chosen task is done.",
};

function TriggerSection({
  draft,
  update,
  err,
  tasks,
  projectsById,
  savedAutomation,
  segmented,
}: SectionProps & {
  tasks: Record<string, { id: string; title: string; state: string; projectId: string }>;
  projectsById: Record<string, { name: string }>;
  savedAutomation: Automation | null;
  segmented: boolean;
}) {
  const cronError = draft.triggerKind === "cron" ? validateCron(draft.cronExpr) : null;
  const cronText =
    draft.triggerKind === "cron" && !cronError
      ? (describeCron(draft.cronExpr, draft.cronTimezone.trim() || undefined) ??
        "Valid expression (no plain-language description available)")
      : null;
  const timezones = useMemo(() => {
    try {
      return (
        Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf?.("timeZone");
    } catch {
      return undefined;
    }
  }, []);
  const tzListId = useId();
  const localTz = localTimezone();
  const taskOptions = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => t.state !== "canceled" || t.id === draft.dependencyTaskId)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [tasks, draft.dependencyTaskId],
  );
  const onceIso = draft.triggerKind === "once" ? localInputToIso(draft.onceAt) : "";

  return (
    <Card stack title="Trigger" description={TRIGGER_HELP[draft.triggerKind]}>
      {segmented ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span aria-hidden className="text-sm font-medium">
            Trigger kind
          </span>
          <div className="overflow-x-auto">
            <SegmentedControl
              label="Trigger kind"
              value={draft.triggerKind}
              onChange={(v) => update("triggerKind", v)}
              options={TRIGGER_KINDS.map((k) => ({ value: k, label: TRIGGER_KIND_LABELS[k] }))}
            />
          </div>
        </div>
      ) : (
        <Field label="Trigger kind">
          {(p) => (
            <Select
              {...p}
              value={draft.triggerKind}
              onChange={(e) => update("triggerKind", e.target.value as TriggerKind)}
            >
              {TRIGGER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {draft.triggerKind === "once" && (
        <Field
          label="Run at"
          error={err("onceAt")}
          hint={`Local time (${localTz})${onceIso ? `; saved as ${onceIso}` : ""}.`}
        >
          {(p) => (
            <TextInput
              {...p}
              type="datetime-local"
              value={draft.onceAt}
              onChange={(e) => update("onceAt", e.target.value)}
            />
          )}
        </Field>
      )}

      {draft.triggerKind === "cron" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Cron expression"
            error={err("cronExpr") ?? cronError ?? undefined}
            hint="minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5"
          >
            {(p) => (
              <TextInput
                {...p}
                aria-invalid={cronError ? true : p["aria-invalid"]}
                value={draft.cronExpr}
                onChange={(e) => update("cronExpr", e.target.value)}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
              />
            )}
          </Field>
          <Field
            label="Timezone"
            error={err("cronTimezone")}
            hint={
              draft.cronTimezone.trim() !== localTz ? (
                <button
                  type="button"
                  className="tap text-accent hover:underline"
                  onClick={() => update("cronTimezone", localTz)}
                >
                  Use this device's timezone ({localTz})
                </button>
              ) : (
                "IANA timezone name; daylight saving is handled."
              )
            }
          >
            {(p) => (
              <>
                <TextInput
                  {...p}
                  list={timezones ? tzListId : undefined}
                  value={draft.cronTimezone}
                  onChange={(e) => update("cronTimezone", e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                />
                {timezones && (
                  <datalist id={tzListId}>
                    {timezones.map((tz) => (
                      <option key={tz} value={tz} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </Field>
          {cronText && (
            <p
              className="flex items-start gap-1.5 text-sm sm:col-span-2"
              aria-live="polite"
              data-testid="cron-description"
            >
              <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="min-w-0 break-words">{cronText}</span>
            </p>
          )}
        </div>
      )}

      {draft.triggerKind === "webhook" && (
        <div className="flex flex-col gap-1 text-sm text-muted">
          <p>
            Senders POST a JSON body (up to 256 KB) with{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>. Use the filters below to fire only for
            matching payloads, and <code>{"{{payload.<path>}}"}</code> to copy payload values into
            the task.
          </p>
          {!savedAutomation ? (
            <p>Save the automation to create its webhook token and URL.</p>
          ) : savedAutomation.trigger.kind !== "webhook" ? (
            <p>Save to switch this automation to a webhook trigger, then create a token.</p>
          ) : (
            <p>
              Token:{" "}
              {savedAutomation.webhookTokenSet
                ? "set (see Webhook below to rotate)"
                : "not created yet"}
            </p>
          )}
        </div>
      )}

      {draft.triggerKind === "dependency" && (
        <Field
          label="When this task is done"
          error={err("dependencyTaskId")}
          hint="Fires once each time the task enters Done."
        >
          {(p) => (
            <Select
              {...p}
              value={draft.dependencyTaskId}
              onChange={(e) => update("dependencyTaskId", e.target.value)}
            >
              <option value="">Choose a task</option>
              {draft.dependencyTaskId && !tasks[draft.dependencyTaskId] && (
                <option value={draft.dependencyTaskId}>Task {draft.dependencyTaskId}</option>
              )}
              {taskOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {projectsById[t.projectId] ? ` (${projectsById[t.projectId]!.name})` : ""}
                  {t.state === "done" ? " - done" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </Card>
  );
}

function FiltersSection({
  draft,
  setDraft,
  err,
}: {
  draft: AutomationDraft;
  setDraft: React.Dispatch<React.SetStateAction<AutomationDraft>>;
  err: Err;
}) {
  const setFilter = (i: number, patch: Partial<{ path: string; equals: string }>) =>
    setDraft((d) => ({
      ...d,
      filters: d.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    }));
  const isWebhook = draft.triggerKind === "webhook";
  return (
    <Card
      stack
      title="Filters"
      description="Filters apply to webhook payloads. Each row compares a dot path (for example pull_request.base.ref) with an exact value; all rows must match. Payloads that do not match are recorded as Filtered out."
    >
      {!isWebhook && (
        <p className="text-sm text-muted">Filters are ignored unless the trigger is Webhook.</p>
      )}
      {draft.filters.length === 0 && (
        <p className="text-sm text-muted">No filters: every payload fires.</p>
      )}
      {draft.filters.map((f, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          key={i}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <Field label={`Path ${i + 1}`} error={err(`filters.${i}.path`)}>
            {(p) => (
              <TextInput
                {...p}
                value={f.path}
                onChange={(e) => setFilter(i, { path: e.target.value })}
                placeholder="action"
                className="font-mono"
                autoCapitalize="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field
            label={`Equals ${i + 1}`}
            error={err(`filters.${i}.equals`)}
            className="col-start-1 row-start-2 sm:col-start-auto sm:row-start-auto"
          >
            {(p) => (
              <TextInput
                {...p}
                value={f.equals}
                onChange={(e) => setFilter(i, { equals: e.target.value })}
                placeholder="opened"
              />
            )}
          </Field>
          <IconButton
            label={`Remove filter ${i + 1}`}
            icon={<X className="size-4" />}
            onClick={() =>
              setDraft((d) => ({ ...d, filters: d.filters.filter((_, j) => j !== i) }))
            }
          />
        </div>
      ))}
      <div>
        <Button
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() =>
            setDraft((d) => ({ ...d, filters: [...d.filters, { path: "", equals: "" }] }))
          }
        >
          Add filter
        </Button>
      </div>
    </Card>
  );
}

function TemplateSection({ draft, update, err }: SectionProps) {
  return (
    <Card
      stack
      title="Task template"
      description={`Use ${TEMPLATE_VARIABLES.join(", ")} in the title, objective, criteria and grouping key.`}
    >
      <Field label="Task title" error={err("title")}>
        {(p) => (
          <TextInput
            {...p}
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="Triage new issues for {{date}}"
          />
        )}
      </Field>
      <Field label="Objective" error={err("objective")}>
        {(p) => (
          <TextArea
            {...p}
            minRows={4}
            value={draft.objective}
            onChange={(e) => update("objective", e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Acceptance criteria"
        error={err("criteria")}
        hint="One criterion per line."
        optional
      >
        {(p) => (
          <TextArea
            {...p}
            minRows={3}
            value={draft.criteria}
            onChange={(e) => update("criteria", e.target.value)}
          />
        )}
      </Field>
      <Field label="Priority" error={err("priority")}>
        {(p) => (
          <div className="flex items-center gap-2">
            <PriorityIcon priority={draft.priority} />
            <Select
              {...p}
              value={String(draft.priority)}
              onChange={(e) => update("priority", Number(e.target.value) as Priority)}
              className="sm:max-w-48"
            >
              {PRIORITY_LABELS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </Field>
    </Card>
  );
}

function RadioCards<T extends string>({
  legend,
  value,
  options,
  onChange,
  hint,
}: {
  legend: string;
  value: T;
  options: { value: T; label: string; explanation: string }[];
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "tap flex min-w-0 cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1",
              value === o.value
                ? "border-accent bg-accent-soft"
                : "border-border hover:bg-surface-2",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}</span>
              <span className="block text-xs text-muted">{o.explanation}</span>
            </span>
          </label>
        ))}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}

function ExecutionSection({
  draft,
  update,
  err,
  hosts,
  profiles,
  defaultHostName,
  defaultProfileName,
  selectedProfileMissing,
}: SectionProps & {
  hosts: { id: string; name: string; connectivity: string }[];
  profiles: { id: string; name: string }[];
  defaultHostName?: string;
  defaultProfileName?: string;
  selectedProfileMissing: boolean;
}) {
  return (
    <Card stack title="Where and how it runs">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Host" error={err("hostId")}>
          {(p) => (
            <Select {...p} value={draft.hostId} onChange={(e) => update("hostId", e.target.value)}>
              <option value="">
                Project default{defaultHostName ? ` (${defaultHostName})` : ""}
              </option>
              {draft.hostId && !hosts.some((h) => h.id === draft.hostId) && (
                <option value={draft.hostId}>Unknown host</option>
              )}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.connectivity !== "connected" ? ` (${h.connectivity})` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Profile"
          error={err("profileId")}
          hint={selectedProfileMissing ? "The selected profile is no longer available." : undefined}
        >
          {(p) => (
            <Select
              {...p}
              value={draft.profileId}
              onChange={(e) => update("profileId", e.target.value)}
            >
              <option value="">
                Project default{defaultProfileName ? ` (${defaultProfileName})` : ""}
              </option>
              {draft.profileId && !profiles.some((pr) => pr.id === draft.profileId) && (
                <option value={draft.profileId}>Unknown profile</option>
              )}
              {profiles.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <RadioCards
        legend="Mode"
        value={draft.mode}
        options={MODE_OPTIONS}
        onChange={(v) => update("mode", v)}
      />
      <Field
        label="Grouping key"
        optional={draft.mode !== "continue"}
        error={err("groupingKey")}
        hint="Occurrences with the same rendered key are the same work: Continue reuses that task and overlap checks compare it. Supports template variables, e.g. pr-{{payload.number}}."
      >
        {(p) => (
          <TextInput
            {...p}
            value={draft.groupingKey}
            onChange={(e) => update("groupingKey", e.target.value)}
            className="font-mono"
            autoCapitalize="off"
            spellCheck={false}
          />
        )}
      </Field>
    </Card>
  );
}

function PoliciesSection({ draft, update }: Omit<SectionProps, "err">) {
  const scheduled = draft.triggerKind === "cron" || draft.triggerKind === "once";
  return (
    <Card stack title="Overlap and missed runs">
      <RadioCards
        legend="When previous work is still open"
        value={draft.overlap}
        options={OVERLAP_OPTIONS}
        onChange={(v) => update("overlap", v)}
      />
      <RadioCards
        legend="Missed runs"
        value={draft.missed}
        options={MISSED_OPTIONS}
        onChange={(v) => update("missed", v)}
        hint={
          scheduled
            ? "A run is missed when the coordinator was down at its scheduled time."
            : "Only applies to Schedule and Once triggers."
        }
      />
    </Card>
  );
}

function LimitsSection({ draft, update, err }: SectionProps) {
  return (
    <Card
      stack
      title="Limits"
      description="Continuation prompts the agent to keep going after a turn ends without finishing. It is off by default."
    >
      <Field label="Automatic continuation">
        {(p) => (
          <Switch
            {...p}
            checked={draft.continuationEnabled}
            onChange={(v) => update("continuationEnabled", v)}
            label="Automatic continuation"
            className="self-start"
          />
        )}
      </Field>
      {draft.continuationEnabled && (
        <>
          <Field
            label="Continuation objective"
            error={err("continuationObjective")}
            hint="What the agent must achieve before it reports done."
          >
            {(p) => (
              <TextArea
                {...p}
                minRows={2}
                value={draft.continuationObjective}
                onChange={(e) => update("continuationObjective", e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max continuations" error={err("maxContinuations")} hint="1–50">
              {(p) => (
                <TextInput
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  step={1}
                  value={draft.maxContinuations}
                  onChange={(e) => update("maxContinuations", e.target.value)}
                />
              )}
            </Field>
            <Field label="Max elapsed minutes" error={err("maxElapsedMinutes")} hint="1–1440">
              {(p) => (
                <TextInput
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  step={1}
                  value={draft.maxElapsedMinutes}
                  onChange={(e) => update("maxElapsedMinutes", e.target.value)}
                />
              )}
            </Field>
            <Field label="Max tokens" optional error={err("maxTokens")}>
              {(p) => (
                <TextInput
                  {...p}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.maxTokens}
                  onChange={(e) => update("maxTokens", e.target.value)}
                />
              )}
            </Field>
            <Field label="Max cost (USD)" optional error={err("maxCostUsd")}>
              {(p) => (
                <TextInput
                  {...p}
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  step={0.01}
                  value={draft.maxCostUsd}
                  onChange={(e) => update("maxCostUsd", e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="text-xs text-muted">
            Token and cost limits are enforced only when the provider reports accounting; otherwise
            the run shows that accounting is unavailable and only the count and time limits apply.
          </p>
        </>
      )}
    </Card>
  );
}

function ReviewSection({
  draft,
  update,
  err,
  projectChecks,
}: SectionProps & { projectChecks?: string[] }) {
  const defaults =
    projectChecks && projectChecks.length > 0
      ? `the project's checks (${projectChecks.join(", ")})`
      : "the project's checks";
  return (
    <Card stack title="Review">
      <Field
        label="Checks"
        optional
        error={err("checks")}
        hint={`One command per line. Leave empty to use ${defaults}.`}
      >
        {(p) => (
          <TextArea
            {...p}
            minRows={2}
            value={draft.checks}
            onChange={(e) => update("checks", e.target.value)}
            className="font-mono"
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
      </Field>
      <Field
        label="Human review"
        hint="When on, finished work waits in Review for you instead of completing on passing checks."
      >
        {(p) => (
          <Switch
            {...p}
            checked={draft.requireHumanReview}
            onChange={(v) => update("requireHumanReview", v)}
            label="Require human review"
            onText="Required"
            offText="Not required"
            className="self-start"
          />
        )}
      </Field>
    </Card>
  );
}
