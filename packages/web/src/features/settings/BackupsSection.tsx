import { Card } from "../../components/ui/Card";
import { CopyBlock } from "../../components/ui/Copy";
import { ErrorState, FatalError, LoadingState } from "../../components/ui/states";
import { formatTime } from "../../lib/time";
import { isObject, useApiResource } from "../../lib/useResource";
import {
  DIAGNOSTICS_PATH,
  type DiagnosticsResponse,
  isDiagnosticsResponse,
} from "./diagnosticsApi";
import { KeyValues, SectionPage } from "./shared";

const BACKUP = "switchyard coordinator backup <file>";
const RESTORE = "switchyard coordinator restore <file>";

function humanKey(k: string): string {
  const s = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatValue(k: string, v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string" && /At$|time|date/i.test(k)) return formatTime(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Settings › Backups: CLI backup/restore plus any backup info the coordinator records. */
export function BackupsSection() {
  const res = useApiResource<DiagnosticsResponse>(DIAGNOSTICS_PATH, isDiagnosticsResponse);
  const backup = res.data && isObject(res.data.backup) ? res.data.backup : null;

  return (
    <SectionPage
      title="Backups"
      description="The coordinator keeps all state in one SQLite database. Back it up from the machine that runs the coordinator."
    >
      <Card title="Back up">
        <p className="mb-2 text-sm">
          Writes a consistent copy of the database to a file while the coordinator keeps running.
        </p>
        <CopyBlock text={BACKUP} label="Backup command" copyLabel="Copy command" />
      </Card>
      <Card title="Restore">
        <p className="mb-2 text-sm">
          Restore refuses to run while the coordinator is running: stop it first. The current
          database is kept next to it as{" "}
          <code className="break-all">coordinator.db.bak-&lt;ts&gt;</code>.
        </p>
        <CopyBlock text={RESTORE} label="Restore command" copyLabel="Copy command" />
        <p className="mt-2 text-sm text-muted">
          Hosts keep running sessions during a coordinator restart and replay their events when it
          comes back.
        </p>
      </Card>
      <Card title="Last backup">
        {res.fatal ? (
          <FatalError error={res.error} />
        ) : res.error && !res.loading && !res.data ? (
          <ErrorState
            compact
            title="Could not load backup info"
            error={res.error}
            onRetry={res.reload}
          />
        ) : !res.data ? (
          <LoadingState label="Loading backup info…" />
        ) : backup && Object.keys(backup).length > 0 ? (
          <KeyValues
            items={Object.entries(backup).map(([k, v]) => [humanKey(k), formatValue(k, v)])}
          />
        ) : (
          <p className="text-sm text-muted">
            No backup info is recorded by the coordinator. Keep track of your backup files yourself,
            or schedule the backup command with cron or launchd.
          </p>
        )}
      </Card>
    </SectionPage>
  );
}
