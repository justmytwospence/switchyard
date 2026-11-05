import type { Host, ProjectScanResult } from "@switchyard/protocol";
import { FolderSearch, Save } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { InlineError } from "../../components/ui/states";
import { TextArea } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiPatch, apiPost } from "../../sync/api";
import { parseProjectFolders, scanSummary } from "./projectFolders";

/** Settings › Hosts › host: the folders whose repositories become projects. */
export function ProjectFoldersCard({ host }: { host: Host }) {
  const id = useId();
  const saved = (host.projectFolders ?? []).join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const text = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const { folders, problem } = parseProjectFolders(text);
  const scan = host.projectScan;
  const running = scanning || scan?.state === "running";
  const connected = host.connectivity === "connected";
  const scanBlocked = !saved
    ? "Save a folder first"
    : !connected
      ? `${host.name} is offline`
      : running
        ? "A scan is running"
        : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/hosts/${encodeURIComponent(host.id)}`, { projectFolders: folders });
      toast.success("Project folders saved");
      setDraft(null);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const scanNow = async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await apiPost<ProjectScanResult>(
        `/api/hosts/${encodeURIComponent(host.id)}/scan-projects`,
      );
      toast.success(`Found ${r.repositories} repositories; ${r.projectsCreated} new projects`);
    } catch (e) {
      setError(e);
    } finally {
      setScanning(false);
    }
  };

  const fieldError = dirty ? problem : null;
  return (
    <Card
      title="Project folders"
      description="Every Git repository directly inside these folders becomes a project, or another checkout of the project with the same remote. Folders are rescanned when the host connects and every 10 minutes; nothing is removed automatically."
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Field
          id={`${id}-folders`}
          label="Folders on this host"
          hint="One per line: an absolute path or ~/..., e.g. ~/Projects."
          error={fieldError}
        >
          <TextArea
            id={`${id}-folders`}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            minRows={3}
            placeholder="~/Projects"
            className="font-mono"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            {...fieldControlProps(`${id}-folders`, { hint: true, error: fieldError })}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Save className="size-4" />}
            busy={saving}
            disabled={!dirty || !!problem}
            onClick={save}
          >
            Save folders
          </Button>
          <Button
            icon={<FolderSearch className="size-4" />}
            busy={scanning}
            disabled={!!scanBlocked}
            title={scanBlocked ?? undefined}
            onClick={scanNow}
          >
            Scan now
          </Button>
        </div>
        <p aria-live="polite" className="text-sm text-muted">
          {scanning ? "Scanning…" : scanSummary(scan)}
        </p>
        {scan && scan.state !== "running" && scan.errors.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-0.5 text-xs text-muted">
            {scan.errors.map((e) => (
              <li key={e} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        )}
        <InlineError error={error} />
      </div>
    </Card>
  );
}
