import { openClients, type View } from "@switchyard/protocol";
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
import { useHosts, useProjects } from "../../sync/store";
import { viewSource } from "../views/describe";
import { useViewDescriber } from "../views/ViewSelect";

/** Where a view's sessions come from, and how to open it in a terminal. */
function ViewAbout({
  view,
  describe,
  onNavigate,
}: {
  view: View;
  describe: (v: View) => string;
  onNavigate: () => void;
}) {
  const source = viewSource(view);
  const open = openClients(view);
  const session = view.name.trim().replace(/\s+/g, "-");
  return (
    <div data-testid="view-about" className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2">
      <p className="text-sm">{describe(view)}</p>
      {source === "tracker" && (
        <p className="text-sm text-muted">
          Managed by a tracker.{" "}
          <TextLink to={ROUTES.settings("trackers")} onClick={onNavigate}>
            Open Trackers
          </TextLink>
        </p>
      )}
      {source === "client" && (
        <p className="text-sm text-muted">
          Sessions are pinned here as they appear. Nothing is opened in that terminal.
        </p>
      )}
      {source !== "client" &&
        (open.length > 0 ? (
          <p className="text-sm text-muted">
            Open in: {open.map((c) => `${c.kind} ${c.name} (${c.machine})`).join(", ")}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Not open in a terminal. To mirror it in herdr:</p>
            <code className="block break-all text-xs">
              switchyard herdr pair --session {session} --view {view.name}
            </code>
          </>
        ))}
    </div>
  );
}

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((x) => x !== id);
}

/**
 * Create, edit and delete views. `editing` is a view id, "new", or null (closed). Empty project
 * and host selections mean "any".
 */
export function ViewsDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: string | "new" | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted?: () => void;
}) {
  const { views, describe } = useViewDescriber();
  const projects = useProjects();
  const hosts = useHosts();
  const [current, setCurrent] = useState<string | "new" | null>(editing);
  const view: View | null = current && current !== "new" ? (views[current] ?? null) : null;
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"all" | "pinned">("all");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setCurrent(editing);
  }, [editing]);
  useEffect(() => {
    setName(view?.name ?? "");
    setMode(view?.mode ?? "all");
    setProjectIds(view?.projectIds ?? []);
    setHostIds(view?.hostIds ?? []);
    setError(null);
  }, [view]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      mode,
      // A tracker's view: the tracker owns the projects.
      ...(view?.trackerId ? {} : { projectIds: projectIds.length ? projectIds : null }),
      hostIds: hostIds.length ? hostIds : null,
    };
    try {
      const saved = view
        ? await apiPatch<View>(`/api/views/${encodeURIComponent(view.id)}`, body)
        : await apiPost<View>("/api/views", body);
      onSaved(saved.id);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!view) return;
    setBusy(true);
    try {
      await apiDelete(`/api/views/${encodeURIComponent(view.id)}`);
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
        title={view ? "Edit view" : "New view"}
        description="A view is a saved filter over sessions and the board."
        footer={
          <>
            {view && (
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
          {Object.keys(views).length > 0 && (
            <Field label="View" id="sy-view-pick">
              {(p) => (
                <Select
                  {...p}
                  value={current ?? ""}
                  onChange={(e) => setCurrent(e.target.value || "new")}
                >
                  <option value="new">New view</option>
                  {Object.values(views).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {view && <ViewAbout view={view} describe={describe} onNavigate={onClose} />}
          <Field label="Name" id="sy-view-name" error={nameError}>
            {(p) => (
              <TextInput
                {...p}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Contents" id="sy-view-mode">
            {(p) => (
              <Select
                {...p}
                value={mode}
                onChange={(e) => setMode(e.target.value as "all" | "pinned")}
              >
                <option value="all">Matching sessions, plus pinned</option>
                <option value="pinned">Only pinned sessions</option>
              </Select>
            )}
          </Field>
          {mode === "all" && (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-sm font-medium">Projects (none checked: any)</legend>
                {projects.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    disabled={!!view?.trackerId}
                    checked={projectIds.includes(p.id)}
                    onChange={(on) => setProjectIds(toggle(projectIds, p.id, on))}
                  />
                ))}
              </fieldset>
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
        title="Delete this view?"
        description="Sessions are not affected. herdr and tmux sessions bound to it stop mirroring and keep their tabs."
        confirmLabel="Delete view"
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
      />
    </>
  );
}
