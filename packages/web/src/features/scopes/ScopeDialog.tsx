import type { Scope } from "@switchyard/protocol";
import { useMemo, useState } from "react";
import { ROUTES } from "../../app/routes";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { RadioCards } from "../../components/ui/RadioCards";
import { ErrorState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { apiDelete, apiPatch, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { shownIn } from "./describe";
import { GitHubSourceFields } from "./GitHubSourceFields";
import type { GitHubSourceDraft } from "./githubSourceLogic";
import { useScopeDescriber } from "./ScopeSelect";
import {
  CONTENTS_OPTIONS,
  disconnects,
  type ScopeDraft,
  type ScopeDraftErrors,
  scopeBodyOf,
  scopeDraftOf,
  validateScopeDraft,
} from "./scopeFormLogic";

/** What a scope contains and the clients that mirror it. */
function ScopeAbout({
  scope,
  describe,
  onNavigate,
}: {
  scope: Scope;
  describe: (v: Scope) => string;
  onNavigate: () => void;
}) {
  const clients = useSyncStore((s) => s.clients);
  const hosts = useSyncStore((s) => s.hosts);
  const shown = shownIn(scope, Object.values(clients), hosts);
  const session = scope.name.trim().replace(/\s+/g, "-");
  return (
    <dl
      data-testid="scope-about"
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-sm"
    >
      <dt className="text-muted">Contains</dt>
      <dd className="min-w-0">{describe(scope)}</dd>
      <dt className="text-muted">Mirrored in</dt>
      <dd className="flex min-w-0 flex-col gap-0.5">
        {shown ?? <span>No client.</span>}
        {!shown && (
          <>
            <span className="text-muted">
              To mirror it in herdr, choose it in{" "}
              <TextLink to={ROUTES.settings("clients")} onClick={onNavigate}>
                Settings › Clients
              </TextLink>
              , or run:
            </span>
            <code className="block break-all text-xs">
              switchyard clients bind herdr:{session} --scope {scope.name}
            </code>
          </>
        )}
      </dd>
    </dl>
  );
}

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((x) => x !== id);
}

/**
 * Create, edit and delete scopes. `editing` is a scope id, "new", or null (closed). Empty project
 * and host selections mean "any".
 */
export function ScopeDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: string | "new" | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { scopes, describe } = useScopeDescriber();
  const projects = useProjects();
  const hosts = useHosts();
  const issues = useSyncStore((s) => s.issues);
  const defaultHost = (hosts.find((h) => h.connectivity === "connected") ?? hosts[0])?.id ?? "";
  const scope: Scope | null = editing && editing !== "new" ? (scopes[editing] ?? null) : null;
  const key = editing ?? "closed";
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScopeDraft>(() => scopeDraftOf(null, defaultHost));
  const [errors, setErrors] = useState<ScopeDraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (draftKey !== key) {
    setDraftKey(key);
    setDraft(scopeDraftOf(scope, defaultHost));
    setErrors({});
    setError(null);
    setConfirmDelete(false);
  }
  const columns = useMemo(() => {
    if (!scope) return [];
    const withBoard = Object.values(issues).find((x) => x.scopeId === scope.id && x.board);
    return withBoard?.board?.options.map((o) => o.name) ?? [];
  }, [issues, scope]);
  const setGithub = <K extends keyof GitHubSourceDraft>(k: K, v: GitHubSourceDraft[K]) =>
    setDraft((d) => ({ ...d, github: { ...d.github, [k]: v } }));

  const save = async () => {
    const found = validateScopeDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    const body = scopeBodyOf(draft, scope);
    try {
      const saved = scope
        ? await apiPatch<Scope>(`/api/scopes/${encodeURIComponent(scope.id)}`, body)
        : await apiPost<Scope>("/api/scopes", body);
      toast.success(`Scope ${saved.name} saved`);
      onSaved(saved.id);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!scope) return;
    setBusy(true);
    try {
      await apiDelete(`/api/scopes/${encodeURIComponent(scope.id)}`);
      toast.success(`Scope ${scope.name} deleted`);
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const conflict = isApiError(error, "conflict") ? errorMessage(error) : null;
  const open = editing !== null;
  return (
    <>
      <Dialog
        open={open && !confirmDelete}
        onClose={onClose}
        title={scope ? "Edit scope" : "New scope"}
        description="A scope is a named part of your work, shown on Sessions and the Board."
        footer={
          <>
            {scope && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)} className="mr-auto">
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!draft.name.trim()}
              onClick={() => void save()}
            >
              {disconnects(draft, scope) ? "Save and disconnect GitHub" : "Save"}
            </Button>
          </>
        }
      >
        <div data-testid="scope-form" className="flex flex-col gap-3">
          {scope && <ScopeAbout scope={scope} describe={describe} onNavigate={onClose} />}
          <Field label="Name" id="sy-scope-name" error={errors.name ?? conflict}>
            {(p) => (
              <TextInput
                {...p}
                value={draft.name}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            )}
          </Field>
          <RadioCards
            legend="Contains"
            columns={1}
            value={draft.contents}
            options={CONTENTS_OPTIONS}
            onChange={(contents) => setDraft({ ...draft, contents })}
          />
          {disconnects(draft, scope) && (
            <p
              role="status"
              className="rounded-md border border-border bg-warning-soft px-3 py-2 text-sm"
            >
              Saving disconnects GitHub: this scope's issues leave the Board. Its sessions and
              worktrees stay.
            </p>
          )}
          {draft.contents === "projects" && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Projects (none checked: any)</legend>
              {projects.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.name}
                  checked={draft.projectIds.includes(p.id)}
                  onChange={(on) =>
                    setDraft({ ...draft, projectIds: toggle(draft.projectIds, p.id, on) })
                  }
                />
              ))}
            </fieldset>
          )}
          {draft.contents === "github" && (
            <GitHubSourceFields
              draft={draft.github}
              errors={errors}
              set={setGithub}
              hosts={hosts}
              columns={columns}
            />
          )}
          {/* Where sessions run is the navigator's Where filter; only scopes that already
              limit hosts keep this, so they can be changed or cleared. */}
          {draft.contents !== "pins" && !!scope?.hostIds?.length && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Hosts (none checked: any)</legend>
              {hosts.map((h) => (
                <Checkbox
                  key={h.id}
                  label={h.name}
                  checked={draft.hostIds.includes(h.id)}
                  onChange={(on) =>
                    setDraft({ ...draft, hostIds: toggle(draft.hostIds, h.id, on) })
                  }
                />
              ))}
            </fieldset>
          )}
          {error !== null && !conflict && (
            <ErrorState compact title="Could not save" error={errorMessage(error)} />
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={open && confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this scope?"
        description={`Sessions are not affected. Clients mirroring it then mirror nothing and keep their tabs.${scope?.source ? " Its issues are removed from the Board." : ""}`}
        confirmLabel="Delete scope"
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
      />
    </>
  );
}
