import type { Client, ClientBindingInput, GitHubScope, Scope } from "@switchyard/protocol";
import { z } from "zod";

/**
 * COMPAT(scopes-rename): remove after 2027-03-01.
 *
 * The shapes 0.20 clients read: scopes as views and trackers, clients as terminals. A daemon or
 * browser tab from 0.20 keeps working against this coordinator through `routes/legacy.ts` and
 * the projection in `client-projection.ts`. See docs/compatibility.md.
 */

/** A scope as a 0.20 view; a GitHub scope names itself as its tracker. */
export function legacyView(s: Scope) {
  return {
    id: s.id,
    name: s.name,
    mode: s.mode,
    projectIds: s.projectIds,
    hostIds: s.hostIds,
    sessionIds: s.sessionIds,
    clients: [],
    trackerId: s.source ? s.id : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** A GitHub scope as a 0.20 tracker. */
export function legacyTracker(s: GitHubScope) {
  const { kind: _kind, ...source } = s.source;
  return {
    id: s.id,
    name: s.name,
    provider: "github" as const,
    ...source,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** A client as a 0.20 terminal: `viewId`, and `mirror: "view"`. */
export function legacyTerminal(c: Client) {
  const { scopeId, mirror, ...rest } = c;
  return { ...rest, mirror: mirror === "scope" ? ("view" as const) : mirror, viewId: scopeId };
}

/** A 0.20 binding: `mirror: "view"` with `viewId`. */
export const LegacyBinding = z.object({
  mirror: z.enum(["none", "all", "view"]),
  viewId: z.string().min(1).nullable().optional(),
});
export type LegacyBinding = z.infer<typeof LegacyBinding>;

export function fromLegacyBinding(b: LegacyBinding): ClientBindingInput {
  return b.mirror === "view"
    ? { mirror: "scope", scopeId: b.viewId ?? null }
    : { mirror: b.mirror };
}

/** A 0.20 daemon's heartbeat (`PUT /api/terminals/:id`). */
export const LegacyReport = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  machine: z.string().min(1),
  hostId: z.string().nullable().optional(),
  shows: z.array(z.string()).max(1000).optional(),
  seed: LegacyBinding.optional(),
});
