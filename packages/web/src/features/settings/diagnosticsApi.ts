import type { AdapterInfo, Connectivity, Diagnostic, Session } from "@switchyard/protocol";
import { isObject } from "../../lib/useResource";

export type ScopedDiagnostic = Diagnostic & { seq?: number; hostId?: string | null };

/** Keep server host identity; only a known session can scope an otherwise unscoped event. */
export function mergeDiagnostics(
  fetched: ScopedDiagnostic[] | undefined,
  live: ScopedDiagnostic[],
  sessions: Record<string, Session>,
): ScopedDiagnostic[] {
  const seen = new Set<string>();
  const out: ScopedDiagnostic[] = [];
  for (const diagnostic of [...(fetched ?? []), ...live]) {
    const hostId =
      diagnostic.hostId ??
      (diagnostic.sessionId ? sessions[diagnostic.sessionId]?.hostId : undefined);
    const d = hostId ? { ...diagnostic, hostId } : diagnostic;
    const key = JSON.stringify([d.hostId ?? null, d.at, d.adapterId, d.sessionId, d.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Response of GET /api/diagnostics (coordinator routes/ops.ts). Fields are read defensively. */
export interface DiagnosticsResponse {
  versions: Record<string, string | number>;
  migrationLevel?: number;
  latestMigration?: number;
  publicUrl?: string | null;
  hosts?: {
    id: string;
    name: string;
    agentVersion?: string;
    piVersion: string | null;
    piCompatible: boolean;
    connectivity: Connectivity;
    lastSeenAt: string | null;
    revokedAt: string | null;
    unsupported?: { capability: string; reason: string }[];
  }[];
  adapters?: Record<string, AdapterInfo[]>;
  diagnostics?: ScopedDiagnostic[];
  events?: {
    minSeq?: number | null;
    maxSeq?: number | null;
    currentSeq?: number | null;
    minRetainedSeq?: number | null;
    retentionDays?: number | null;
  };
  push?: { vapidConfigured?: boolean; subscriptions?: number };
  clients?: { connectedDevices?: number };
  /** Not produced by the coordinator yet; shown when present. */
  backup?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export function isDiagnosticsResponse(v: unknown): v is DiagnosticsResponse {
  return isObject(v) && isObject(v.versions);
}

export const DIAGNOSTICS_PATH = "/api/diagnostics";
