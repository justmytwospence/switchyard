import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_FRAME_MAX_BYTES,
  AgentRequestFrame,
  AgentResultFrame,
  ErrorBody,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { z } from "zod";

const Id = z.string().min(1).max(200);
export type BridgeState = NonNullable<Session["bridge"]>;
export const AgentContextIds = AgentRequestFrame.shape.context;
export type AgentContextIds = z.infer<typeof AgentContextIds>;
export const BridgeCapabilities = z.object({
  agentTools: z.boolean(),
  messageDelivery: z.boolean(),
  editorDraftGuard: z.boolean(),
  toolPolicy: z.boolean(),
});
export type BridgeCapabilities = z.infer<typeof BridgeCapabilities>;
export const BridgeHello = z.object({
  type: z.literal("agent.hello"),
  version: z.literal(1),
  runtimeId: Id,
  nativeSessionId: Id,
  sessionFile: z.string().nullable(),
  pid: z.number().int().positive(),
  mode: z.enum(["rpc", "terminal"]),
  capabilities: BridgeCapabilities,
  context: AgentContextIds,
});
export type BridgeHello = z.infer<typeof BridgeHello>;
/** Payload of the bridge_features event: an actual extension hello, not inferred support. */
export type BridgeFeatures = BridgeHello;
export const BridgeConfiguration = z.object({
  version: z.literal(1),
  sessionId: Id,
  runtimeId: Id,
  nativeSessionId: Id,
  bindingId: Id,
  features: z.array(z.string()),
  coordinatorConnected: z.boolean(),
  policyRequired: z.boolean(),
  sessionUrl: z.string().nullable(),
});
export type BridgeConfiguration = z.infer<typeof BridgeConfiguration>;

export const DeliveryOffer = z
  .object({
    deliveryId: Id,
    kind: z.enum(["message", "completion"]),
    text: z
      .string()
      .refine((text) => Buffer.byteLength(text, "utf8") <= 64 * 1024, "Text exceeds 64 KiB"),
    mode: z.enum(["steer", "queue"]),
    holdUntil: z.string().refine((value) => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    }, "Expected canonical ISO timestamp"),
  })
  .refine(
    (offer) => Buffer.byteLength(JSON.stringify(offer), "utf8") <= 96 * 1024,
    "Offer exceeds 96 KiB",
  );
export type DeliveryOffer = z.infer<typeof DeliveryOffer>;
export const DeliveryAttempt = z.object({
  id: z.string().uuid(),
  runtimeId: Id,
  nativeSessionId: Id,
});
export type DeliveryAttempt = z.infer<typeof DeliveryAttempt>;
const OfferHash = z.string().regex(/^[a-f0-9]{64}$/);
export function deliveryOfferHash(offer: DeliveryOffer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([1, offer.deliveryId, offer.kind, offer.text, offer.mode, offer.holdUntil]),
      "utf8",
    )
    .digest("hex");
}
export const DeliveryAcceptArgs = z
  .object({
    offer: DeliveryOffer,
    offerHash: OfferHash,
    attempt: DeliveryAttempt,
  })
  .refine((args) => args.offerHash === deliveryOfferHash(args.offer), "Offer hash mismatch");
export type DeliveryAcceptArgs = z.infer<typeof DeliveryAcceptArgs>;
export const DeliveryStatusArgs = z.object({
  deliveryId: Id,
  offerHash: OfferHash,
  attempt: DeliveryAttempt,
});
export type DeliveryStatusArgs = z.infer<typeof DeliveryStatusArgs>;
export const DeliveryEvidence = z.object({
  deliveryId: Id,
  attempt: DeliveryAttempt,
  state: z.enum(["not_seen", "held", "queued", "appended", "uncertain"]),
  proof: z.enum(["live_memory", "native_entry", "none"]),
  safeToRetry: z.boolean(),
  reason: z.enum(["draft", "dialog", "effect_unknown"]).nullable(),
  effectiveMode: z.enum(["steer", "queue"]).nullable(),
  entryId: z.string().nullable(),
});
export type DeliveryEvidence = z.infer<typeof DeliveryEvidence>;

export const BridgeCommandHeader = z.object({
  type: z.literal("bridge.command"),
  requestId: Id,
  runtimeId: Id,
  nativeSessionId: Id,
  bindingId: Id,
});
export type BridgeCommandHeader = z.infer<typeof BridgeCommandHeader>;
export const BridgeCommand = z
  .discriminatedUnion("method", [
    BridgeCommandHeader.extend({ method: z.literal("configure"), args: BridgeConfiguration }),
    BridgeCommandHeader.extend({
      method: z.literal("connection.update"),
      args: z.object({ connected: z.boolean() }),
    }),
    BridgeCommandHeader.extend({
      method: z.literal("input.human"),
      args: z.object({ humanInputId: Id }),
    }),
    BridgeCommandHeader.extend({ method: z.literal("delivery.accept"), args: DeliveryAcceptArgs }),
    BridgeCommandHeader.extend({ method: z.literal("delivery.status"), args: DeliveryStatusArgs }),
  ])
  .refine(
    (command) =>
      command.method !== "configure" ||
      (command.runtimeId === command.args.runtimeId &&
        command.nativeSessionId === command.args.nativeSessionId &&
        command.bindingId === command.args.bindingId),
    "Configure identity mismatch",
  );
export type BridgeCommand = z.infer<typeof BridgeCommand>;
export type BridgeMethod = BridgeCommand["method"];
const ReceiptHeader = BridgeCommandHeader.omit({ type: true }).extend({
  type: z.literal("bridge.receipt"),
});
export const BridgeReceipt = z.discriminatedUnion("ok", [
  ReceiptHeader.extend({ ok: z.literal(true), result: z.unknown() }),
  ReceiptHeader.extend({ ok: z.literal(false), error: ErrorBody }),
]);
export type BridgeReceipt = z.infer<typeof BridgeReceipt>;
/** Inherit the optional canonical deadline and strict trust metadata; only ingress requires it. */
export const BridgeAgentRequest = AgentRequestFrame.extend({ bindingId: Id });
export type BridgeAgentRequest = z.infer<typeof BridgeAgentRequest>;
export const BridgeAgentResult = z.discriminatedUnion("ok", [
  AgentResultFrame.options[0].extend({ bindingId: Id }),
  AgentResultFrame.options[1].extend({ bindingId: Id }),
]);
export type BridgeAgentResult = z.infer<typeof BridgeAgentResult>;
export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function checkSize(record: unknown): void {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > AGENT_FRAME_MAX_BYTES)
    throw new SwitchyardError("invalid_request", "Bridge frame exceeds 128 KiB");
}

/** Scripts mirror these records without importing workspace packages. Unknown records stay native. */
export function parseBridgeRecord(
  record: unknown,
): BridgeAgentRequest | BridgeHello | BridgeReceipt | null {
  if (!record || typeof record !== "object") return null;
  const type = (record as Record<string, unknown>).type;
  if (type !== "agent.request" && type !== "agent.hello" && type !== "bridge.receipt") return null;
  checkSize(record);
  if (type === "agent.request") return BridgeAgentRequest.parse(record);
  if (type === "agent.hello") return BridgeHello.parse(record);
  return BridgeReceipt.parse(record);
}

export function validateAgentResult(frame: BridgeAgentResult): BridgeAgentResult {
  checkSize(frame);
  return BridgeAgentResult.parse(frame);
}

interface Pending {
  identity: Pick<BridgeCommandHeader, "runtimeId" | "nativeSessionId" | "bindingId">;
  configuration: BridgeConfiguration | null;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Independent from native RPC ids; receipts are handled synchronously by the socket reader. */
export class BridgeRequests {
  private readonly pending = new Map<string, Pending>();
  private hello: BridgeHello | null = null;
  private configuration: BridgeConfiguration | null = null;

  setHello(hello: BridgeHello): void {
    this.cancel("Bridge announced a new controller/native binding");
    this.hello = hello;
  }

  accepts(frame: BridgeAgentRequest): boolean {
    const config = this.configuration;
    return (
      config !== null &&
      frame.sessionId === config.sessionId &&
      frame.runtimeId === config.runtimeId &&
      frame.nativeSessionId === config.nativeSessionId &&
      frame.bindingId === config.bindingId
    );
  }

  request<T>(
    method: BridgeMethod,
    args: unknown,
    send: (frame: BridgeCommand) => Promise<void>,
    options: BridgeRequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted)
      return Promise.reject(new SwitchyardError("conflict", "Bridge request canceled"));
    if (this.pending.size >= 256)
      return Promise.reject(
        new SwitchyardError("rate_limited", "Too many pending bridge requests"),
      );
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
      return Promise.reject(
        new SwitchyardError(
          "invalid_request",
          "Bridge timeout must be positive and at most 30 seconds",
        ),
      );
    let frame: BridgeCommand;
    let configuration: BridgeConfiguration | null = null;
    try {
      if (!this.hello)
        throw new SwitchyardError("host_unreachable", "Bridge has not announced its identity");
      if (method === "configure") {
        configuration = BridgeConfiguration.parse(args);
        if (
          configuration.runtimeId !== this.hello.runtimeId ||
          configuration.nativeSessionId !== this.hello.nativeSessionId
        )
          throw new SwitchyardError("conflict", "Configure does not match the latest bridge hello");
      }
      const identity = configuration ?? this.configuration;
      if (!identity) throw new SwitchyardError("conflict", "Bridge is not configured");
      frame = BridgeCommand.parse({
        type: "bridge.command",
        requestId: `bridge-${randomUUID()}`,
        runtimeId: identity.runtimeId,
        nativeSessionId: identity.nativeSessionId,
        bindingId: identity.bindingId,
        method,
        args,
      });
      checkSize(frame);
    } catch (error) {
      return Promise.reject(
        error instanceof z.ZodError
          ? new SwitchyardError("invalid_request", "Invalid bridge command", error.issues)
          : error,
      );
    }
    if (configuration) {
      const hello = this.hello;
      this.cancel("Bridge configuration replaced");
      this.hello = hello;
    }
    return new Promise<T>((resolve, reject) => {
      const { requestId } = frame;
      const fail = (error: Error) => {
        const p = this.pending.get(requestId);
        if (!p) return;
        this.pending.delete(requestId);
        p.cleanup();
        reject(error);
      };
      const abort = () => fail(new SwitchyardError("conflict", "Bridge request canceled"));
      const timer = setTimeout(
        () =>
          fail(
            new SwitchyardError(
              "timeout",
              `Bridge did not answer ${method} within ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(requestId, {
        identity: frame,
        configuration,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        void send(frame).catch(fail);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receive(receipt: BridgeReceipt): void {
    const p = this.pending.get(receipt.requestId);
    if (
      !p ||
      receipt.runtimeId !== p.identity.runtimeId ||
      receipt.nativeSessionId !== p.identity.nativeSessionId ||
      receipt.bindingId !== p.identity.bindingId
    )
      return;
    this.pending.delete(receipt.requestId);
    p.cleanup();
    if (receipt.ok) {
      if (p.configuration) this.configuration = p.configuration;
      p.resolve(receipt.result);
    } else
      p.reject(
        new SwitchyardError(receipt.error.code, receipt.error.message, receipt.error.details),
      );
  }

  cancel(reason: string): void {
    this.configuration = null;
    this.hello = null;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new SwitchyardError("host_unreachable", reason));
    }
    this.pending.clear();
  }
}
