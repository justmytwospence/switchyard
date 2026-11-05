import type { AdapterInfo, Diagnostic } from "@switchyard/protocol";
import { CircleCheck, CircleSlash, CircleX, Info, Puzzle, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Card } from "../../components/ui/Card";
import { InlineStatus } from "../../components/ui/StatusChip";
import { EmptyState, ErrorState, LastKnownNote, LoadingState } from "../../components/ui/states";
import { formatTime } from "../../lib/time";
import { isObject, useApiResource } from "../../lib/useResource";
import { useSyncStore } from "../../sync/store";
import { KeyValues, SectionPage, settingsPath, useHydrated } from "./shared";

const ADAPTER_STATUS = {
  active: { icon: CircleCheck, label: "Active", tone: "success" },
  disabled: { icon: CircleSlash, label: "Disabled", tone: "neutral" },
  error: { icon: CircleX, label: "Error", tone: "danger" },
} as const;

export function AdapterStatus({ status }: { status: AdapterInfo["status"] }) {
  const s = ADAPTER_STATUS[status] ?? ADAPTER_STATUS.error;
  return <InlineStatus icon={s.icon} label={s.label} tone={s.tone} />;
}

const TIER_LABEL: Record<AdapterInfo["tier"], string> = {
  project: "Project",
  owner: "Owner",
  plugin: "Plugin",
  bundled: "Bundled",
};

const LEVEL = {
  info: { icon: Info, label: "Info", tone: "info" },
  warning: { icon: TriangleAlert, label: "Warning", tone: "warning" },
  error: { icon: CircleX, label: "Error", tone: "danger" },
} as const;

export function DiagnosticLevel({ level }: { level: Diagnostic["level"] }) {
  const l = LEVEL[level] ?? LEVEL.info;
  return <InlineStatus icon={l.icon} label={l.label} tone={l.tone} />;
}

interface DiagnosticsLike {
  diagnostics?: (Diagnostic & { seq?: number })[];
}

/** Store diagnostics (live) merged with the coordinator's recent history. */
export function useAllDiagnostics(fetched: Diagnostic[] | undefined): Diagnostic[] {
  const live = useSyncStore((s) => s.diagnostics);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Diagnostic[] = [];
    for (const d of [...(fetched ?? []), ...live]) {
      const key = `${d.at}|${d.adapterId ?? ""}|${d.sessionId ?? ""}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [fetched, live]);
}

/** Settings › Adapters: adapters on each host plus their recent diagnostics. */
export function AdaptersSection() {
  const hydrated = useHydrated();
  const adapters = useSyncStore((s) => s.adapters);
  const hosts = useSyncStore((s) => s.hosts);
  const diag = useApiResource<DiagnosticsLike>("/api/diagnostics", isObject);
  const diagnostics = useAllDiagnostics(
    Array.isArray(diag.data?.diagnostics) ? diag.data.diagnostics : undefined,
  );

  const groups = useMemo(
    () =>
      Object.entries(adapters)
        .filter(([, list]) => list.length > 0)
        .map(([hostId, list]) => ({
          hostId,
          hostName: hosts[hostId]?.name ?? `Unknown host (${hostId})`,
          adapters: [...list].sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => a.hostName.localeCompare(b.hostName)),
    [adapters, hosts],
  );

  return (
    <SectionPage
      title="Adapters"
      description="Adapters translate Pi extensions into Switchyard cards, panels and interactions. Each host reports its own."
    >
      <LastKnownNote />
      {diag.error !== null && !diag.loading && !diag.fatal && (
        <ErrorState
          compact
          title="Could not load adapter diagnostics history"
          error={diag.error}
          onRetry={diag.reload}
        />
      )}
      {!hydrated ? (
        <LoadingState label="Loading adapters…" />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Puzzle className="size-8" />}
          title="No adapters reported"
          description="Hosts report adapters when their agent connects. Check that your hosts are connected."
          action={{ label: "Open hosts", to: settingsPath("hosts") }}
        />
      ) : (
        groups.map((g) => (
          <section key={g.hostId} className="flex min-w-0 flex-col gap-3">
            <h2 className="text-base font-semibold">
              <Link
                to={settingsPath(`hosts/${encodeURIComponent(g.hostId)}`)}
                className="hover:underline"
              >
                {g.hostName}
              </Link>
            </h2>
            {g.adapters.map((a) => (
              <AdapterCard
                key={a.id}
                adapter={a}
                diagnostics={diagnostics.filter((d) => d.adapterId === a.id)}
              />
            ))}
          </section>
        ))
      )}
    </SectionPage>
  );
}

function AdapterCard({
  adapter: a,
  diagnostics,
}: {
  adapter: AdapterInfo;
  diagnostics: Diagnostic[];
}) {
  return (
    <Card
      title={<span className="break-all font-mono">{a.id}</span>}
      actions={<AdapterStatus status={a.status} />}
    >
      <KeyValues
        items={[
          ["Version", a.version],
          ["Tier", TIER_LABEL[a.tier] ?? a.tier],
          [
            "Target extension",
            <span key="t" className="break-all font-mono">
              {a.target.extension}
            </span>,
          ],
          [
            "Version range",
            <span key="r" className="font-mono">
              {a.target.versionRange}
            </span>,
          ],
          [
            "Tested versions",
            a.target.testedVersions.length ? a.target.testedVersions.join(", ") : "None recorded",
          ],
          ["Capabilities", a.capabilities.length ? a.capabilities.join(", ") : "None"],
          [
            "Web renderer",
            a.webRenderer
              ? "Yes (runs in a sandboxed frame; mobile uses a fallback)"
              : "No (native cards only)",
          ],
          ...(a.detail ? ([["Detail", a.detail]] as [string, string][]) : []),
        ]}
      />
      <h3 className="mt-3 mb-1 text-sm font-semibold">Recent diagnostics</h3>
      {diagnostics.length === 0 ? (
        <p className="text-sm text-muted">No diagnostics for this adapter.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {diagnostics.slice(0, 10).map((d) => (
            <li
              key={`${d.at}-${d.message}`}
              className="flex min-w-0 flex-wrap items-start gap-2 text-sm"
            >
              <DiagnosticLevel level={d.level} />
              <span className="min-w-0 flex-1 break-words">{d.message}</span>
              <time dateTime={d.at} className="text-xs text-muted">
                {formatTime(d.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
