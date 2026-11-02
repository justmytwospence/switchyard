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
  Task,
  Workspace,
} from "./entities.js";
import { EventEnvelope, StreamDelta } from "./events.js";

export const SyncState = z.object({
  hosts: z.array(Host),
  projects: z.array(Project),
  checkouts: z.array(Checkout),
  workspaces: z.array(Workspace),
  profiles: z.array(Profile),
  sessions: z.array(Session),
  tasks: z.array(Task),
  runs: z.array(Run),
  automations: z.array(Automation),
  attention: z.array(AttentionItem),
  interactions: z.array(Interaction),
  panels: z.array(Panel),
  devices: z.array(Device),
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

export const ClientToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), cursor: z.number().int().nullable() }),
  z.object({ type: z.literal("presence"), presence: Presence }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientToServer = z.infer<typeof ClientToServer>;

export const ServerToClient = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replay"),
    seq: z.number().int(),
    events: z.array(EventEnvelope),
  }),
  z.object({ type: z.literal("snapshot"), seq: z.number().int(), state: SyncState }),
  z.object({ type: z.literal("event"), event: EventEnvelope }),
  z.object({ type: z.literal("stream"), delta: StreamDelta }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("force_logout"), reason: z.string() }),
]);
export type ServerToClient = z.infer<typeof ServerToClient>;
