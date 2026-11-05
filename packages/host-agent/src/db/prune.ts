import type { HostDb } from "./index.js";

/** Rows of ended sessions and finished dispatches are kept this long. */
export const HOST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a running agent prunes. */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PruneCounts {
  interactions: number;
  panels: number;
  dispatches: number;
}

/** Sessions that ended before the cutoff; records written before `endedAt` existed use `lastActivityAt`. */
const ENDED = `SELECT id FROM sessions
  WHERE json_extract(json, '$.runtime') IN ('stopped', 'failed', 'interrupted')
    AND COALESCE(json_extract(json, '$.endedAt'), json_extract(json, '$.lastActivityAt')) < ?`;

/**
 * Delete interactions (never pending ones) and panels of sessions that ended more than
 * `retentionMs` ago, and started or failed dispatches older than that. Session records and adapter
 * state are kept: the coordinator may resume any session, its transcript order lives in the
 * record, and adapters restore their state on resume.
 */
export function pruneHostDb(
  db: HostDb,
  now = Date.now(),
  retentionMs = HOST_RETENTION_MS,
): PruneCounts {
  const cutoff = new Date(now - retentionMs).toISOString();
  return db.tx(() => ({
    interactions: db.run(
      `DELETE FROM interactions WHERE state <> 'pending' AND session_id IN (${ENDED})`,
      [cutoff],
    ).changes,
    panels: db.run(`DELETE FROM panels WHERE session_id IN (${ENDED})`, [cutoff]).changes,
    dispatches: db.run(
      "DELETE FROM dispatches WHERE state IN ('started', 'failed') AND updated_at < ?",
      [cutoff],
    ).changes,
  }));
}
