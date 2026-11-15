import type { SessionAdaptersResult } from "@switchyard/protocol";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { ErrorState, LoadingState, UnsupportedCapability } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { useResource } from "../../lib/useResource";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import type { SessionContext } from "./hooks";

/** Inspection is authoritative for this session, never inferred from the host catalog. */
export function AdapterDiagnostics({ ctx }: { ctx: SessionContext }) {
  if (!ctx.host?.capabilities?.adapterDevelopment) {
    return (
      <UnsupportedCapability
        capability="Session adapter inspection and reload"
        reason="This host does not support adapter development. Update its host agent to inspect live adapters."
      />
    );
  }
  return <SessionAdapterDiagnostics key={ctx.session.id} ctx={ctx} />;
}

function SessionAdapterDiagnostics({ ctx }: { ctx: SessionContext }) {
  const { session } = ctx;
  const pending = useSyncStore(
    (s) =>
      Object.values(s.interactions).filter(
        (i) => i.sessionId === session.id && i.state === "pending",
      ).length,
  );
  const result = useResource<SessionAdaptersResult>(
    ctx.link === "connected"
      ? `${session.id}:${session.adapterGeneration ?? "legacy"}:${session.runtime}:${pending}`
      : null,
    (signal) => codeApi.adapters(session.id, signal),
    { refreshMs: 5000 },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason =
    ctx.link !== "connected"
      ? "Connect to this session's host to reload adapters."
      : session.readOnly
        ? "This session is read-only."
        : session.archivedAt
          ? "Unarchive this session to reload adapters."
          : result.error !== null
            ? "Refresh diagnostics to confirm adapter readiness."
            : (result.data?.blockedReason ??
              (result.data?.reloadable ? null : "Adapter readiness is not available yet."));
  const reload = async () => {
    if (busy || reason || !result.data?.reloadable) return;
    setBusy(true);
    setError(null);
    try {
      await codeApi.reloadAdapters(session.id);
      // Inspection is a separate read; the reload acknowledgement carries only the new generation.
      result.reload();
      toast.success("Adapters reloaded.");
    } catch (e) {
      setError(errorMessage(e));
      result.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Session adapters" className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-semibold">Session adapters</h3>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={result.reload}
          disabled={busy || result.loading || ctx.link !== "connected"}
        >
          Refresh diagnostics
        </Button>
        <Button
          size="sm"
          busy={busy}
          disabled={!!reason || result.loading}
          onClick={() => void reload()}
        >
          Reload adapters
        </Button>
      </div>
      {reason && <p className="text-sm text-muted">{reason}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {result.loading && !result.data && <LoadingState label="Inspecting session adapters…" />}
      {result.error !== null && (
        <ErrorState
          compact
          title="Could not inspect session adapters"
          error={result.error}
          onRetry={result.reload}
        />
      )}
      {result.data && <AdapterDiagnosticsList result={result.data} />}
    </section>
  );
}

/** Kept separate so inspection fixtures can exercise the same portable list. */
export function AdapterDiagnosticsList({ result }: { result: SessionAdaptersResult }) {
  return (
    <>
      {result.adapters.length === 0 && (
        <p className="text-sm text-muted">No adapters enabled for this session.</p>
      )}
      <ul className="flex min-w-0 flex-col gap-3">
        {result.adapters.map((a) => (
          <li
            key={`${a.tier}:${a.id}`}
            className="min-w-0 rounded-md border border-border p-2 text-sm"
          >
            <p className="font-medium break-words">{a.target.extension}</p>
            <p>
              Adapter {a.version} · Target {a.provenance.targetVersion ?? "version unknown"} ·{" "}
              {a.provenance.scope}
            </p>
            <p>
              Catalog: {a.status} · Runtime: {a.runtimeStatus}
            </p>
            {a.detail && <p className="break-words text-muted">{a.detail}</p>}
            {a.runtimeDetail && <p className="break-words text-muted">{a.runtimeDetail}</p>}
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer">Source and identifiers</summary>
              <dl className="mt-1 space-y-1 break-all">
                <dt>Adapter ID</dt>
                <dd>{a.id}</dd>
                <dt>Tier</dt>
                <dd>{a.tier}</dd>
                <dt>Evidence</dt>
                <dd>{a.provenance.evidence}</dd>
                <dt>Source</dt>
                <dd>{a.provenance.source ?? "Not reported"}</dd>
                <dt>Package</dt>
                <dd>{a.provenance.packageDir ?? "Not reported"}</dd>
                <dt>Manifest</dt>
                <dd>{a.provenance.manifestPath ?? "Not reported"}</dd>
                <dt>Entrypoints</dt>
                <dd>
                  {a.provenance.entrypoints.length
                    ? a.provenance.entrypoints.join(", ")
                    : "Not declared (package-level matching)"}
                </dd>
              </dl>
            </details>
          </li>
        ))}
      </ul>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Runtime identifiers</summary>
        <p className="break-all">Generation: {result.generation ?? "Not reported"}</p>
        <p className="break-all">Runtime: {result.runtimeId ?? "Not reported"}</p>
      </details>
      <h4 className="text-sm font-semibold">Latest session diagnostics</h4>
      {result.diagnostics.length === 0 ? (
        <p className="text-sm text-muted">No diagnostics.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2 text-sm">
          {[...result.diagnostics]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((d, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no ID
              <li key={`${d.at}:${index}`} className="min-w-0 break-words">
                <span className={d.level === "error" ? "text-danger" : "text-muted"}>
                  {d.level}:{" "}
                </span>
                {d.message} <span className="text-xs text-muted">{formatRelative(d.at)}</span>
                {d.adapterId && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">Adapter ID</summary>
                    {d.adapterId}
                  </details>
                )}
              </li>
            ))}
        </ul>
      )}
    </>
  );
}
