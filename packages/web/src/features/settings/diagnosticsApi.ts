import type { AdapterInfo, Connectivity, Diagnostic } from "@switchyard/protocol";
import { isObject } from "./useResource";

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
  diagnostics?: (Diagnostic & { seq?: number; hostId?: string | null })[];
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
