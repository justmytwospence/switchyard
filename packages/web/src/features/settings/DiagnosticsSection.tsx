import { PI_SUPPORTED_RANGE } from "@switchyard/protocol";
import { CircleCheck, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { StatusChip } from "../../components/ui/StatusChip";
import { ErrorState, FatalError, LoadingState } from "../../components/ui/states";
import { formatRelative, formatTime } from "../../lib/time";
import { useSyncStore } from "../../sync/store";
import { DiagnosticLevel, useAllDiagnostics } from "./AdaptersSection";
import {
  DIAGNOSTICS_PATH,
  type DiagnosticsResponse,
  isDiagnosticsResponse,
} from "./diagnosticsApi";
import {
  Card,
  copyText,
  InlineStatus,
  KeyValues,
  LastKnownNote,
  PiCompat,
  SectionPage,
} from "./shared";
import { useResource } from "./useResource";

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "Unknown" : String(v));

/** Settings › Diagnostics: GET /api/diagnostics rendered readably. */
export function DiagnosticsSection() {
  const res = useResource<DiagnosticsResponse>(DIAGNOSTICS_PATH, isDiagnosticsResponse);
  const d = res.data;
  const diagnostics = useAllDiagnostics(Array.isArray(d?.diagnostics) ? d.diagnostics : undefined);
  const hostsById = useSyncStore((s) => s.hosts);

  const actions = (
    <>
      <Button
        icon={<Copy className="size-4" />}
        disabled={!d}
        onClick={() => d && copyText(JSON.stringify(d, null, 2), "Diagnostics JSON copied")}
      >
        Copy diagnostics JSON
      </Button>
      <Button
        busy={res.loading && !!d}
        icon={<RefreshCw className="size-4" />}
        onClick={res.reload}
      >
        Refresh
      </Button>
    </>
  );

  let body: React.ReactNode;
  if (res.fatal) body = <FatalError error={res.error} diagnosticsHref="/settings/diagnostics" />;
  else if (res.error && !d)
    body = <ErrorState title="Could not load diagnostics" error={res.error} onRetry={res.reload} />;
  else if (!d) body = <LoadingState label="Loading diagnostics…" />;
  else {
    const migrationCurrent =
      d.migrationLevel !== undefined &&
      d.latestMigration !== undefined &&
      d.migrationLevel >= d.latestMigration;
    const hosts = (d.hosts ?? []).filter((h) => !h.revokedAt);
    body = (
      <>
        {res.error ? (
          <ErrorState compact title="Refresh failed" error={res.error} onRetry={res.reload} />
        ) : null}
        <Card title="Versions">
          <div className="overflow-x-auto">
            <table className="w-full min-w-0 text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Component
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Version
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.versions).map(([k, v]) => (
                  <tr key={k} className="border-b border-border last:border-b-0">
                    <th scope="row" className="py-1 pr-4 font-normal capitalize">
                      {k}
                    </th>
                    <td className="py-1 font-mono break-all">{show(v)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-1 pr-4 font-normal">
                    Supported Pi
                  </th>
                  <td className="py-1 font-mono">{PI_SUPPORTED_RANGE}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Coordinator">
          <KeyValues
            items={[
              [
                "Database migration",
                <span key="m" className="inline-flex flex-wrap items-center gap-2">
                  <span>
                    Level {show(d.migrationLevel)} of {show(d.latestMigration)}
                  </span>
                  {migrationCurrent ? (
                    <InlineStatus icon={CircleCheck} tone="success" label="Up to date" />
                  ) : (
                    <InlineStatus icon={TriangleAlert} tone="warning" label="Behind latest" />
                  )}
                </span>,
              ],
              [
                "Public URL",
                <span key="u" className="break-all">
                  {show(d.publicUrl)}
                </span>,
              ],
              [
                "Events",
                d.events
                  ? `Seq ${show(d.events.minSeq)} to ${show(d.events.maxSeq)} stored (current ${show(
                      d.events.currentSeq,
                    )}, oldest retained ${show(d.events.minRetainedSeq)})`
                  : "Unknown",
              ],
              [
                "Event retention",
                d.events?.retentionDays != null ? `${d.events.retentionDays} days` : "Unknown",
              ],
              [
                "Push",
                d.push
                  ? `${d.push.vapidConfigured ? "VAPID keys configured" : "VAPID keys not configured"}, ${show(
                      d.push.subscriptions,
                    )} subscription(s)`
                  : "Unknown",
              ],
              ["Connected clients", `${show(d.clients?.connectedDevices)} device(s)`],
            ]}
          />
        </Card>

        <Card title="Hosts">
          {hosts.length === 0 ? (
            <p className="text-sm text-muted">No hosts enrolled.</p>
          ) : (
            <ul className="flex min-w-0 flex-col divide-y divide-border">
              {hosts.map((h) => {
                const live = hostsById[h.id];
                return (
                  <li key={h.id} className="flex min-w-0 flex-col gap-1 py-2 text-sm">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{h.name}</span>
                      <StatusChip kind="host" value={live?.connectivity ?? h.connectivity} />
                      <PiCompat host={h} />
                    </div>
                    <div className="text-xs text-muted">
                      Agent {show(h.agentVersion)} · Last seen {formatRelative(h.lastSeenAt)}
                    </div>
                    {h.unsupported && h.unsupported.length > 0 && (
                      <ul className="list-disc pl-5 text-xs text-muted">
                        {h.unsupported.map((u) => (
                          <li key={u.capability} className="break-words">
                            {u.capability}: {u.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Recent diagnostics">
          {diagnostics.length === 0 ? (
            <p className="text-sm text-muted">No diagnostics recorded.</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-2">
              {diagnostics.slice(0, 100).map((x, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id; list is sorted and deduplicated
                  key={`${x.at}-${i}`}
                  className="flex min-w-0 flex-wrap items-start gap-2 text-sm"
                >
                  <DiagnosticLevel level={x.level} />
                  <span className="min-w-0 flex-1 break-words">
                    {x.message}
                    {x.adapterId && (
                      <span className="block text-xs text-muted">Adapter {x.adapterId}</span>
                    )}
                  </span>
                  <time dateTime={x.at} className="text-xs text-muted">
                    {formatTime(x.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }

  return (
    <SectionPage
      title="Diagnostics"
      description="Versions, database state, hosts and recent problems. Copy the JSON when reporting a problem."
      actions={actions}
    >
      <LastKnownNote />
      {body}
    </SectionPage>
  );
}
