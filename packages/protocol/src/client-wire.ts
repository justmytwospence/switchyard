import { z } from "zod";
import {
  AdapterInfo,
  AttentionItem,
  Automation,
  Checkout,
  Client,
  Device,
  Host,
  Interaction,
  Panel,
  Profile,
  Project,
  Run,
  Scope,
  Session,
  Task,
  Workspace,
} from "./entities.js";
import { EventEnvelope, StreamDelta } from "./events.js";
import { TrackedIssue } from "./issues.js";

export const SyncState = z.object({
  hosts: z.array(Host),
  projects: z.array(Project),
  checkouts: z.array(Checkout),
  workspaces: z.array(Workspace),
  profiles: z.array(Profile),
  /** Scopes; absent from coordinators before 0.21. */
  scopes: z.array(Scope).default([]),
  sessions: z.array(Session),
  tasks: z.array(Task),
  runs: z.array(Run),
  automations: z.array(Automation),
  attention: z.array(AttentionItem),
  interactions: z.array(Interaction),
  panels: z.array(Panel),
  devices: z.array(Device),
  /** Tracked issues; absent from older coordinators. */
  issues: z.array(TrackedIssue).default([]),
  /** Clients (herdr and tmux sessions); absent from coordinators before 0.21. */
  clients: z.array(Client).default([]),
  adapters: z.record(z.string(), z.array(AdapterInfo)),
  dispatchPaused: z.boolean(),
});
export type SyncState = z.infer<typeof SyncState>;

export const Presence = z.object({
  foreground: z.boolean(),
  interactedAt: z.string().nullable(),
  viewing: z.object({ sessionId: z.string() }).nullable(),
  /**
   * A herdr or tmux daemon reporting the session focused in its client (kept apart from the
   * device's own presence).
   */
  clientId: z.string().min(1).max(200).optional(),
  /** COMPAT(scopes-rename): remove after 2027-03-01. The old name of clientId. */
  terminalId: z.string().min(1).max(200).optional(),
});
export type Presence = z.infer<typeof Presence>;

/**
 * `scopes.v1`: the client reads `scopes` and `clients` and the `scope.*` and `client.*` events.
 * Without it the coordinator sends 0.20's `views` and `terminals` (COMPAT(scopes-rename)).
 */
export const CLIENT_CAPABILITIES = [
  "adapter.slots.v1",
  "timeline.cards.v1",
  "scopes.v1",
  /** The client reads `ToolItemData.view`. */
  "tool.views.v1",
  /** The client draws checklist, facts, rows and badge nodes, `section.open` and URL refs. */
  "ui.nodes.v2",
  /** The client draws `composer.tracker` and `session.badge` contributions. */
  "adapter.trackers.v1",
] as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

export const ClientToServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    cursor: z.number().int().nullable(),
    capabilities: z.array(z.string().min(1).max(80)).max(32).optional(),
    projectionId: z.string().max(256).nullable().optional(),
  }),
  z.object({ type: z.literal("presence"), presence: Presence }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientToServer = z.infer<typeof ClientToServer>;

export const ServerToClient = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replay"),
    seq: z.number().int(),
    events: z.array(EventEnvelope),
    capabilities: z.array(z.enum(CLIENT_CAPABILITIES)).optional(),
    projectionId: z.string().optional(),
  }),
  z.object({
    type: z.literal("snapshot"),
    seq: z.number().int(),
    state: SyncState,
    capabilities: z.array(z.enum(CLIENT_CAPABILITIES)).optional(),
    projectionId: z.string().optional(),
  }),
  z.object({ type: z.literal("event"), event: EventEnvelope }),
  z.object({ type: z.literal("stream"), delta: StreamDelta }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("force_logout"), reason: z.string() }),
]);
export type ServerToClient = z.infer<typeof ServerToClient>;
