import { z } from "zod";
import { ErrorBody } from "./errors.js";

const Id = z.string().min(1).max(200);
export const AGENT_FRAME_MAX_BYTES = 128 * 1024;
export const AgentMethod = z.enum([
  "session.bind",
  "task.create",
  "message.send",
  "inbox.read",
  "policy.evaluate",
  "policy.status",
  "policy.cancel",
]);
export type AgentMethod = z.infer<typeof AgentMethod>;

export const CreateAgentTask = z.object({
  objective: z.string().min(1).max(16000),
  acceptance: z.array(z.string().min(1).max(2000)).max(100).default([]),
  dependencies: z.array(Id).max(100).default([]),
  parentTaskId: Id.nullable().optional(),
  hostId: Id.optional(),
  profileId: Id.optional(),
  notifyOnFinish: z.boolean().default(true),
});
export type CreateAgentTask = z.infer<typeof CreateAgentTask>;
export const SendAgentMessage = z.object({
  sessionId: Id,
  body: z.string().min(1).max(16000),
  mode: z.enum(["steer", "queue"]),
  replyTo: Id.optional(),
});
export type SendAgentMessage = z.infer<typeof SendAgentMessage>;
export const ReadAgentInbox = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20),
});
export type ReadAgentInbox = z.infer<typeof ReadAgentInbox>;

export const DeliveryState = z.enum([
  "pending",
  "held",
  "deferred",
  "accepted",
  "queued",
  "appended",
  "uncertain",
  "failed",
]);
export type DeliveryState = z.infer<typeof DeliveryState>;
export const AgentMessage = z.object({
  seq: z.number().int().positive(),
  id: Id,
  kind: z.enum(["message", "completion"]),
  senderSessionId: Id,
  recipientSessionId: Id,
  replyTo: Id.nullable(),
  chainId: Id,
  depth: z.number().int().min(0).max(4),
  body: z.unknown(),
  requestedMode: z.enum(["steer", "queue"]),
  deliveryState: DeliveryState,
  holdUntil: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;
export const AgentInbox = z.object({
  messages: z.array(AgentMessage),
  nextAfter: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type AgentInbox = z.infer<typeof AgentInbox>;
export const AgentRequestFrame = z.object({
  type: z.literal("agent.request"),
  requestId: Id,
  sessionId: Id,
  nativeSessionId: Id,
  runtimeId: Id,
  context: z.object({ humanInputId: Id.nullable(), causalMessageId: Id.nullable() }),
  toolCallId: Id.optional(),
  method: AgentMethod,
  args: z.unknown(),
});
export type AgentRequestFrame = z.infer<typeof AgentRequestFrame>;
export const AgentResultFrame = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("agent.result"),
    requestId: Id,
    runtimeId: Id,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("agent.result"),
    requestId: Id,
    runtimeId: Id,
    ok: z.literal(false),
    error: ErrorBody,
  }),
]);
export type AgentResultFrame = z.infer<typeof AgentResultFrame>;
