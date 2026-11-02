import { z } from "zod";
import {
  AdapterInfo,
  AttentionItem,
  Automation,
  Checkout,
  Device,
  Diagnostic,
  Host,
  Interaction,
  Occurrence,
  Panel,
  Profile,
  Project,
  Run,
  Session,
  Task,
  TranscriptItem,
  Workspace,
} from "./entities.js";

/** Durable event payloads by type. `data` is the full new entity unless noted. */
export const EventDataSchemas = {
  "host.updated": Host,
  "project.updated": Project,
  "project.deleted": z.object({ id: z.string() }),
  "checkout.updated": Checkout,
  "workspace.updated": Workspace,
  "workspace.removed": z.object({ id: z.string() }),
  "profile.updated": Profile,
  "profile.deleted": z.object({ id: z.string() }),
  "session.updated": Session,
  "transcript.item": TranscriptItem,
  "interaction.updated": Interaction,
  "panel.updated": Panel,
  "adapters.updated": z.object({ hostId: z.string(), adapters: z.array(AdapterInfo) }),
  diagnostic: Diagnostic,
  "task.updated": Task,
  "task.deleted": z.object({ id: z.string() }),
  "run.updated": Run,
  "automation.updated": Automation,
  "automation.deleted": z.object({ id: z.string() }),
  "occurrence.created": Occurrence,
  "attention.updated": AttentionItem,
  "device.updated": Device,
  "settings.updated": z.object({ dispatchPaused: z.boolean() }),
} as const;

export type EventType = keyof typeof EventDataSchemas;
export const EVENT_TYPES = Object.keys(EventDataSchemas) as EventType[];
export const EventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

export type EventData<T extends EventType> = z.infer<(typeof EventDataSchemas)[T]>;

export const EventScope = z.object({
  hostId: z.string().optional(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
});
export type EventScope = z.infer<typeof EventScope>;

export const EventEnvelope = EventScope.extend({
  seq: z.number().int(),
  id: z.string(),
  type: EventTypeSchema,
  at: z.string(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Typed view of an envelope. */
export type TypedEvent<T extends EventType = EventType> = Omit<EventEnvelope, "type" | "data"> & {
  type: T;
  data: EventData<T>;
};

/** Parse `data` against its type schema. */
export function parseEventData<T extends EventType>(type: T, data: unknown): EventData<T> {
  return (EventDataSchemas[type] as unknown as z.ZodType<EventData<T>>).parse(data);
}

/** Events a host may emit (subset of all types). */
export const HOST_EVENT_TYPES = [
  "session.updated",
  "transcript.item",
  "interaction.updated",
  "panel.updated",
  "adapters.updated",
  "diagnostic",
  "workspace.updated",
  "workspace.removed",
] as const satisfies readonly EventType[];
export type HostEventType = (typeof HOST_EVENT_TYPES)[number];

export const HostEvent = EventScope.extend({
  eventId: z.string(),
  type: z.enum(HOST_EVENT_TYPES),
  at: z.string(),
  data: z.unknown(),
});
export type HostEvent = z.infer<typeof HostEvent>;

/** Ephemeral streaming delta, never persisted or sequenced. */
export const StreamDelta = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  kind: z.enum(["text", "thinking", "tool_args", "tool_output"]),
  delta: z.string(),
  order: z.number().int().optional(),
});
export type StreamDelta = z.infer<typeof StreamDelta>;
