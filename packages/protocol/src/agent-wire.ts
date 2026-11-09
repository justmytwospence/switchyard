import { z } from "zod";
import { ErrorBody } from "./errors.js";
import { PolicyEvaluation } from "./policies.js";

const Id = z.string().min(1).max(200);
const Instant = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "Expected canonical UTC timestamp");
export const AGENT_FRAME_MAX_BYTES = 128 * 1024;
export const AgentMethod = z.enum([
  "session.bind",
  "task.create",
  "message.send",
  "inbox.read",
  "receipt.peek",
  "policy.evaluate",
  "policy.status",
  "policy.cancel",
]);
export type AgentMethod = z.infer<typeof AgentMethod>;

const AgentToolMethod = z.enum(["task.create", "message.send", "inbox.read"]);
const RequestHash = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentReceiptPeekRequest = z
  .object({ method: AgentToolMethod, args: z.record(z.string(), z.json()) })
  .strict();
export type AgentReceiptPeekRequest = z.infer<typeof AgentReceiptPeekRequest>;
export const AgentReceiptPeekResult = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z.object({ found: z.literal(true), requestHash: RequestHash }).strict(),
]);
export type AgentReceiptPeekResult = z.infer<typeof AgentReceiptPeekResult>;
export const AgentReceiptReplay = z.object({ requestHash: RequestHash }).strict();
export type AgentReceiptReplay = z.infer<typeof AgentReceiptReplay>;

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
const AgentMessageFields = {
  seq: z.number().int().positive(),
  id: Id,
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
};
export const AgentMessage = z.discriminatedUnion("kind", [
  z.object({ ...AgentMessageFields, kind: z.literal("message"), senderSessionId: Id }),
  z.object({
    ...AgentMessageFields,
    kind: z.literal("completion"),
    senderSessionId: Id.nullable(),
  }),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;
export const AgentInbox = z.object({
  messages: z.array(AgentMessage),
  nextAfter: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type AgentInbox = z.infer<typeof AgentInbox>;

/** Nonfinal request-policy ASK: the caller must wait, then explicitly retry the same tool call. */
export const AgentToolPolicyWait = PolicyEvaluation.options[2]
  .omit({ verdict: true })
  .extend({ type: z.literal("policy.required") })
  .strict();
export type AgentToolPolicyWait = z.infer<typeof AgentToolPolicyWait>;

export const AgentRequestFrame = z
  .object({
    type: z.literal("agent.request"),
    requestId: Id,
    sessionId: Id,
    nativeSessionId: Id,
    runtimeId: Id,
    context: z.object({ humanInputId: Id.nullable(), causalMessageId: Id.nullable() }).strict(),
    toolCallId: Id.optional(),
    receiptReplay: AgentReceiptReplay.optional(),
    // Tool-method ingress requires this separately; legacy/non-tool frames remain compatible.
    deadlineAt: Instant.optional(),
    method: AgentMethod,
    args: z.unknown(),
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (frame.method === "receipt.peek") {
      if (!frame.toolCallId) {
        ctx.addIssue({
          code: "custom",
          path: ["toolCallId"],
          message: "Receipt lookup requires a tool call ID.",
        });
      }
    }
    if (Object.hasOwn(frame, "receiptReplay") && !AgentToolMethod.safeParse(frame.method).success) {
      ctx.addIssue({
        code: "custom",
        path: ["receiptReplay"],
        message: "Receipt replay is only valid for tool methods.",
      });
    }
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
