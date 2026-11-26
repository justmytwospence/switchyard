import type { Scope } from "@switchyard/protocol";
import { useEffect, useState } from "react";
import { ROUTES } from "../../app/routes";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { ErrorState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { apiDelete, apiPatch, apiPost, errorMessage, isApiError } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { scopeSourceKind, shownIn } from "../scopes/describe";
import { useScopeDescriber } from "../scopes/ScopeSelect";

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
  const source = scopeSourceKind(scope);
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
      <dd className="flex min-w-0 flex-col gap-0.5">
        <span>{describe(scope)}</span>
        {source === "github" && (
          <span className="text-muted">
            Its projects are kept by GitHub.{" "}
            <TextLink to={ROUTES.settings("scopes")} onClick={onNavigate}>
              Open Scopes
            </TextLink>
          </span>
        )}
      </dd>
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
  onDeleted?: () => void;
}) {
  const { scopes, describe } = useScopeDescriber();
  const projects = useProjects();
  const hosts = useHosts();
  const [current, setCurrent] = useState<string | "new" | null>(editing);
  const scope: Scope | null = current && current !== "new" ? (scopes[current] ?? null) : null;
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"all" | "pinned">("all");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const source = scope ? scopeSourceKind(scope) : "manual";

  useEffect(() => {
    setCurrent(editing);
  }, [editing]);
  useEffect(() => {
    setName(scope?.name ?? "");
    setMode(scope?.mode ?? "all");
    setProjectIds(scope?.projectIds ?? []);
    setHostIds(scope?.hostIds ?? []);
    setError(null);
  }, [scope]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      ...(source === "manual" ? { mode } : {}),
      // A GitHub scope: GitHub keeps the projects.
      ...(scope?.source ? {} : { projectIds: projectIds.length ? projectIds : null }),
      hostIds: hostIds.length ? hostIds : null,
    };
    try {
      const saved = scope
        ? await apiPatch<Scope>(`/api/scopes/${encodeURIComponent(scope.id)}`, body)
        : await apiPost<Scope>("/api/scopes", body);
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
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const nameError = isApiError(error, "conflict") ? errorMessage(error) : null;
  const open = current !== null;
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
              disabled={!name.trim()}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {Object.keys(scopes).length > 0 && (
            <Field label="Scope" id="sy-scope-pick">
              {(p) => (
                <Select
                  {...p}
                  value={current ?? ""}
                  onChange={(e) => setCurrent(e.target.value || "new")}
                >
                  <option value="new">New scope</option>
                  {Object.values(scopes).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {scope && <ScopeAbout scope={scope} describe={describe} onNavigate={onClose} />}
          <Field label="Name" id="sy-scope-name" error={nameError}>
            {(p) => (
              <TextInput
                {...p}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {source === "manual" && (
            <Field label="Sessions" id="sy-scope-mode">
              {(p) => (
                <Select
                  {...p}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "all" | "pinned")}
                >
                  <option value="all">Matching the filters below, plus any you pin</option>
                  <option value="pinned">Only sessions you pin</option>
                </Select>
              )}
            </Field>
          )}
          {mode === "all" && (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-sm font-medium">
                  {scope?.source ? "Projects (kept by GitHub)" : "Projects (none checked: any)"}
                </legend>
                {projects.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    disabled={!!scope?.source}
                    checked={projectIds.includes(p.id)}
                    onChange={(on) => setProjectIds(toggle(projectIds, p.id, on))}
                  />
                ))}
              </fieldset>
              {/* Where sessions run is the navigator's Where filter; only scopes that already
                  limit hosts keep this, so they can be changed or cleared. */}
              {!!scope?.hostIds?.length && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm font-medium">Hosts (none checked: any)</legend>
                  {hosts.map((h) => (
                    <Checkbox
                      key={h.id}
                      label={h.name}
                      checked={hostIds.includes(h.id)}
                      onChange={(on) => setHostIds(toggle(hostIds, h.id, on))}
                    />
                  ))}
                </fieldset>
              )}
            </>
          )}
          {error !== null && !nameError && (
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
