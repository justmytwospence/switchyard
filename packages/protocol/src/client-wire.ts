import { z } from "zod";
import {
  AdapterInfo,
  AttentionItem,
  Automation,
  Checkout,
  Device,
  Host,
  Interaction,
  Panel,
  Profile,
  Project,
  Run,
  Session,
  Surface,
  Task,
  View,
  Workspace,
} from "./entities.js";
import { EventEnvelope, StreamDelta } from "./events.js";
import { TrackedIssue } from "./trackers.js";

export const SyncState = z.object({
  hosts: z.array(Host),
  projects: z.array(Project),
  checkouts: z.array(Checkout),
  workspaces: z.array(Workspace),
  profiles: z.array(Profile),
  views: z.array(View),
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
  /** Terminal surfaces; absent from older coordinators. */
  surfaces: z.array(Surface).default([]),
  adapters: z.record(z.string(), z.array(AdapterInfo)),
  dispatchPaused: z.boolean(),
});
export type SyncState = z.infer<typeof SyncState>;

export const Presence = z.object({
  foreground: z.boolean(),
  interactedAt: z.string().nullable(),
  viewing: z.object({ sessionId: z.string() }).nullable(),
});
export type Presence = z.infer<typeof Presence>;

export const CLIENT_CAPABILITIES = ["adapter.slots.v1", "timeline.cards.v1"] as const;
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
