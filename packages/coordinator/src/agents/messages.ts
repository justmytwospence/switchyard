import { randomUUID } from "node:crypto";
import {
  type AgentInbox,
  AgentMessage,
  DeliveryState,
  ReadAgentInbox,
  SendAgentMessage,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { z } from "zod";
import type { HostHub } from "../host-hub.js";
import { parse } from "../http.js";
import type { Store } from "../store.js";

export const MESSAGE_HOLD_MS = 10 * 60_000;
export const INBOX_PAGE_BYTES = 120 * 1024;
const DELIVERY_BATCH = 20;
const FINAL_STATES = new Set<DeliveryState>(["appended", "failed"]);

/** Only the authenticated broker/service may supply this context, never tool arguments. */
export interface MessageCausalContext {
  humanInputId: string | null;
  causalMessageId: string | null;
}

export interface MessagePayload {
  deliveryId: string;
  kind: AgentMessage["kind"];
  text: string;
}

/**
 * Integration adapter for HostHub. Acceptance uses the supplied deterministic command ID;
 * status MUST use a fresh read-only command, not the original acceptance receipt.
 * A null status means the host has no durable record. It is not permission to re-enqueue.
 */
export interface MessageDeliveryTransport {
  isConnected(hostId: string): boolean;
  accept(
    hostId: string,
    job: {
      sessionId: string;
      messageId: string;
      payload: MessagePayload;
      mode: "steer" | "queue";
      holdUntil: string;
    },
    options: { commandId: string },
  ): Promise<{ state: DeliveryState }>;
  status(
    hostId: string,
    sessionId: string,
    messageId: string,
  ): Promise<{ state: DeliveryState } | null>;
}

const HostMessageStatus = z.object({ messageId: z.string().min(1), state: DeliveryState });

/** The host owns durable delivery jobs; acceptance receipts never stand in for status reads. */
export function createMessageDeliveryTransport(hostHub: HostHub): MessageDeliveryTransport {
  const requireFeature = (hostId: string) => {
    if (!hostHub.negotiatedFeatures(hostId).has("agentRequests.v1")) {
      throw new SwitchyardError("unsupported_capability", "Host message delivery is unavailable");
    }
  };
  return {
    isConnected: (hostId) =>
      hostHub.isConnected(hostId) && hostHub.negotiatedFeatures(hostId).has("agentRequests.v1"),
    async accept(hostId, job, options) {
      requireFeature(hostId);
      const result = parse(
        HostMessageStatus,
        await hostHub.request(
          hostId,
          {
            type: "session.deliverMessage",
            ...job,
          },
          options,
        ),
      );
      if (result.messageId !== job.messageId) {
        throw new SwitchyardError("invalid_request", "Mismatched host message receipt");
      }
      return result;
    },
    async status(hostId, sessionId, messageId) {
      requireFeature(hostId);
      const result = parse(
        z.object({ messages: z.array(HostMessageStatus).max(1) }),
        await hostHub.request(hostId, {
          type: "session.messageStatus",
          sessionId,
          messageIds: [messageId],
        }),
      );
      const message = result.messages[0];
      if (message && message.messageId !== messageId) {
        throw new SwitchyardError("invalid_request", "Mismatched host message status");
      }
      return message ?? null;
    },
  };
}

/** Completion capture owns formatting and supplies its already-bounded immutable snapshot. */
export interface CompletionMessageInput {
  id: string;
  senderSessionId: string | null;
  recipientSessionId: string;
  body: unknown;
  text: string;
  createdAt: string;
}

interface MessageRow {
  seq: number;
  id: string;
  kind: AgentMessage["kind"];
  sender_session_id: string | null;
  recipient_session_id: string;
  reply_to: string | null;
  chain_id: string;
  depth: number;
  body_json: string;
  requested_mode: "steer" | "queue";
  delivery_state: DeliveryState;
  hold_until: string;
  read_at: string | null;
  created_at: string;
}

export function messageSenderTitle(title: string): string {
  // Strip controls (including line breaks), and flatten Unicode line separators.
  return Array.from(title.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[\u2028\u2029]/gu, " "))
    .slice(0, 120)
    .join("");
}

export function ordinaryMessageHeader(id: string, senderTitle: string): string {
  return `[Switchyard message ${id} from ${messageSenderTitle(senderTitle)}] Call switchyard_inbox to read it.`;
}

/** Durable inbox storage. All mutation APIs are synchronous and nest in AgentService's tx. */
export class MessageService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private scanAfter = 0;
  private inFlight = new Map<string, Promise<void>>();
  private readonly onHostConnected = () => this.wake();
  private readonly onEvent = (event: { type: string }) => {
    if (event.type === "session.updated") this.wake();
  };

  constructor(
    private readonly store: Store,
    private readonly transport: MessageDeliveryTransport,
  ) {}

  /**
   * AgentService checks receipts BEFORE calling send, then writes its receipt in the SAME
   * outer Store.tx. This method does not invent a second idempotency identity.
   */
  send(callerSessionId: string, input: SendAgentMessage): AgentMessage {
    const args = SendAgentMessage.parse(input);
    return this.store.tx(() => {
      const caller = this.store.sessions.require(callerSessionId);
      const target = this.store.sessions.require(args.sessionId);
      if (caller.id === target.id) {
        throw new SwitchyardError(
          "invalid_request",
          "Use your current session directly instead of sending to yourself.",
        );
      }
      if (!caller.projectId || !target.projectId || caller.projectId !== target.projectId) {
        throw new SwitchyardError(
          "invalid_request",
          "Messages require sessions in the same project.",
        );
      }
      if (target.archivedAt || target.readOnly || !this.isResumable(target)) {
        throw new SwitchyardError(
          "invalid_request",
          "The recipient must be live or resumable and writable.",
        );
      }
      const causalId = this.context(caller.id).causalMessageId;
      const causal = causalId ? this.requireCausalMessage(caller.id, causalId) : undefined;
      const parentId = args.replyTo ?? causalId;
      const parent = parentId ? this.requireCausalMessage(caller.id, parentId) : undefined;
      if (causal && parent && causal.chainId !== parent.chainId) {
        throw new SwitchyardError(
          "conflict",
          "A reply cannot substitute another causal message chain.",
        );
      }
      const depth = causal || parent ? Math.max(causal?.depth ?? -1, parent?.depth ?? -1) + 1 : 0;
      if (depth > 4) {
        throw new SwitchyardError(
          "invalid_request",
          "Reply limit reached. Wait for human input before continuing this exchange.",
        );
      }
      const now = this.store.now();
      const count = this.store.st
        .get(`SELECT COUNT(*) AS n FROM agent_messages WHERE kind = 'message'
          AND sender_session_id = ? AND recipient_session_id = ? AND created_at > ?`)
        .get(caller.id, target.id, new Date(now.getTime() - 60_000).toISOString()) as { n: number };
      if (count.n >= 10) {
        throw new SwitchyardError(
          "rate_limited",
          "At most 10 messages per recipient per rolling minute.",
        );
      }
      const pending = this.store.st
        .get(`SELECT COUNT(*) AS n FROM agent_messages WHERE kind = 'message'
          AND recipient_session_id = ? AND delivery_state NOT IN ('appended', 'failed')`)
        .get(target.id) as { n: number };
      if (pending.n >= 100) {
        throw new SwitchyardError(
          "rate_limited",
          "The recipient already has 100 pending messages.",
        );
      }
      const id = `msg_${randomUUID()}`;
      return insertMessage(
        this.store,
        {
          id,
          kind: "message",
          senderSessionId: caller.id,
          recipientSessionId: target.id,
          replyTo: parent?.id ?? null,
          chainId: parent?.chainId ?? id,
          depth,
          body: args.body,
          requestedMode: args.mode,
          createdAt: now.toISOString(),
        },
        ordinaryMessageHeader(id, caller.title),
      );
    });
  }

  /** For captureTaskCompletion's outer transaction; bypasses ordinary rate/pending limits. */
  captureCompletion(input: CompletionMessageInput): AgentMessage {
    return captureCompletionMessage(this.store, input);
  }

  /**
   * Persist trusted native-branch context. Reattachment with the same human ID is NOT a reset.
   * Delivery receipts cannot set context: a delayed append receipt could otherwise undo human
   * input that happened after injection. The broker reports the actual active native branch.
   */
  recordContext(sessionId: string, context: MessageCausalContext): void {
    this.store.tx(() => {
      this.store.sessions.require(sessionId);
      const incoming = context.causalMessageId
        ? this.requireCausalMessage(sessionId, context.causalMessageId)
        : undefined;
      const previous = this.context(sessionId);
      const sameHuman = previous.humanInputId === context.humanInputId;
      const prior =
        sameHuman && previous.causalMessageId
          ? this.requireCausalMessage(sessionId, previous.causalMessageId)
          : undefined;
      const causalMessageId =
        prior && (!incoming || (prior.chainId === incoming.chainId && prior.depth > incoming.depth))
          ? prior.id
          : (incoming?.id ?? null);
      this.store.setSetting(this.contextKey(sessionId), {
        humanInputId: context.humanInputId,
        causalMessageId,
      } satisfies MessageCausalContext);
    });
  }

  /** Owner inspection passes markRead:false; inbox reads and their receipt share the caller's tx. */
  readInbox(
    callerSessionId: string,
    input: Partial<ReadAgentInbox> = {},
    options: { markRead?: boolean } = {},
  ): AgentInbox {
    const args = ReadAgentInbox.parse(input);
    return this.store.tx(() => {
      this.store.sessions.require(callerSessionId);
      const rows = this.store.st
        .get(`SELECT * FROM agent_messages WHERE recipient_session_id = ? AND seq > ?
          ORDER BY seq LIMIT ?`)
        .all(callerSessionId, args.after, args.limit + 1) as unknown as MessageRow[];
      const page: AgentInbox = { messages: [], nextAfter: args.after, hasMore: false };
      const now = this.store.nowIso();
      for (const row of rows) {
        const message = messageFromRow(row);
        if (options.markRead !== false) message.readAt ??= now;
        const candidate = {
          messages: [...page.messages, message],
          nextAfter: message.seq,
          // false is one byte longer than true: size for the larger final representation.
          hasMore: false,
        };
        if (
          page.messages.length === args.limit ||
          Buffer.byteLength(JSON.stringify(candidate)) > INBOX_PAGE_BYTES
        ) {
          if (!page.messages.length) {
            throw new SwitchyardError(
              "too_large",
              "An inbox item exceeds the serialized page limit.",
            );
          }
          page.hasMore = true;
          break;
        }
        page.messages.push(message);
        page.nextAfter = message.seq;
      }
      if (options.markRead !== false) {
        for (const message of page.messages) {
          this.store.st
            .get("UPDATE agent_messages SET read_at = COALESCE(read_at, ?) WHERE id = ?")
            .run(now, message.id);
        }
      }
      return page;
    });
  }

  get(id: string): AgentMessage | undefined {
    return getMessage(this.store, id);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.store.hub.on("host.connected", this.onHostConnected);
    this.store.hub.on("messages.pending", this.onHostConnected);
    this.store.hub.on("event", this.onEvent);
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.hub.off("host.connected", this.onHostConnected);
    this.store.hub.off("messages.pending", this.onHostConnected);
    this.store.hub.off("event", this.onEvent);
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Bounded, rotating scan so held/offline recipients cannot starve later inbox entries. */
  async deliverPending(): Promise<void> {
    if (this.stopped) return;
    let rows = this.store.st
      .get(`SELECT * FROM agent_messages
      WHERE delivery_state NOT IN ('appended', 'failed') AND seq > ? ORDER BY seq LIMIT ?`)
      .all(this.scanAfter, DELIVERY_BATCH) as unknown as MessageRow[];
    if (!rows.length && this.scanAfter) {
      this.scanAfter = 0;
      rows = this.store.st
        .get(`SELECT * FROM agent_messages
        WHERE delivery_state NOT IN ('appended', 'failed') ORDER BY seq LIMIT ?`)
        .all(DELIVERY_BATCH) as unknown as MessageRow[];
    }
    if (rows.length) this.scanAfter = rows[rows.length - 1]!.seq;
    const groups = new Map<string, AgentMessage[]>();
    for (const row of rows) {
      if (this.inFlight.has(row.recipient_session_id)) continue;
      const group = groups.get(row.recipient_session_id) ?? [];
      group.push(messageFromRow(row));
      groups.set(row.recipient_session_id, group);
    }
    await Promise.all(
      [...groups].map(([sessionId, messages]) =>
        this.claim(sessionId, async () => {
          for (const message of messages) {
            if (this.stopped) break;
            await this.deliverOne(message);
          }
        }),
      ),
    );
  }

  /** Read-only host reconciliation, including uncertain jobs (which are NEVER reaccepted). */
  async reconcileDelivery(messageId: string): Promise<void> {
    if (this.stopped) return;
    const message = this.get(messageId);
    if (
      !message ||
      FINAL_STATES.has(message.deliveryState) ||
      this.inFlight.has(message.recipientSessionId)
    )
      return;
    await this.claim(message.recipientSessionId, () => this.reconcileOne(message));
  }

  private async claim(sessionId: string, work: () => Promise<void>): Promise<void> {
    // Defer work until after the per-target lock is visible, including to after-commit wakeups.
    const promise = Promise.resolve()
      .then(work)
      .finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, promise);
    await promise;
  }

  private async deliverOne(message: AgentMessage): Promise<void> {
    if (message.deliveryState === "uncertain" || this.wasAccepted(message.id)) {
      await this.reconcileOne(message);
      return;
    }
    const target = this.liveTarget(message);
    if (!target) {
      this.updateState(message.id, "deferred");
      return;
    }
    const payload = this.payload(message.id);
    // Missing immutable payload is not permission to reconstruct it from mutable session data.
    if (!payload) {
      this.updateState(message.id, "failed");
      return;
    }
    try {
      const result = await this.transport.accept(
        target.hostId,
        {
          sessionId: target.id,
          messageId: message.id,
          payload,
          // Never change the logical command payload on retry. The host/extension applies expiry.
          mode: message.requestedMode,
          holdUntil: message.holdUntil,
        },
        { commandId: `msg_${message.id}` },
      );
      this.store.tx(() => {
        this.store.setSetting(this.acceptedKey(message.id), true);
        this.updateState(message.id, result.state);
      });
    } catch {
      // Retrying durable host acceptance is safe, unlike retrying Pi enqueue. Keep the same ID.
      this.updateState(message.id, "deferred");
    }
  }

  private async reconcileOne(message: AgentMessage): Promise<void> {
    const target = this.liveTarget(message);
    if (!target) return; // Preserve evidence of host acceptance while disconnected/stopped.
    try {
      const result = await this.transport.status(target.hostId, target.id, message.id);
      // Losing a previously accepted durable job cannot prove that Pi did not enqueue it.
      this.updateState(message.id, result?.state ?? "uncertain");
    } catch {
      // A failed read says nothing about the delivery state. Retry the READ on a later tick.
    }
  }

  private liveTarget(message: AgentMessage): Session | undefined {
    const session = this.store.sessions.get(message.recipientSessionId);
    if (
      !session ||
      session.archivedAt ||
      session.readOnly ||
      !this.isLive(session) ||
      !session.bridge?.messageDelivery ||
      !this.transport.isConnected(session.hostId)
    )
      return;
    return session;
  }

  private isLive(session: Session): boolean {
    return ["idle", "running", "waiting_input"].includes(session.runtime);
  }

  private isResumable(session: Session): boolean {
    return this.isLive(session) || !!session.nativeHandle;
  }

  private updateState(id: string, state: DeliveryState): void {
    this.store.tx(() => {
      const previous = this.get(id);
      if (!previous || FINAL_STATES.has(previous.deliveryState) || previous.deliveryState === state)
        return;
      // Only positive queued/append evidence can resolve uncertainty, never a pending/held report.
      if (previous.deliveryState === "uncertain" && state !== "appended" && state !== "queued")
        return;
      this.store.st
        .get("UPDATE agent_messages SET delivery_state = ?, updated_at = ? WHERE id = ?")
        .run(state, this.store.nowIso(), id);
    });
  }

  private requireCausalMessage(sessionId: string, id: string): AgentMessage {
    const message = this.get(id);
    if (!message || message.recipientSessionId !== sessionId) {
      throw new SwitchyardError(
        "invalid_request",
        "replyTo must identify a message addressed to this session.",
      );
    }
    return message;
  }

  private context(sessionId: string): MessageCausalContext {
    return this.store.getSetting(this.contextKey(sessionId), {
      humanInputId: null,
      causalMessageId: null,
    });
  }

  private contextKey(id: string): string {
    return `agentMessageContext:${id}`;
  }
  private payloadKey(id: string): string {
    return payloadKey(id);
  }
  private acceptedKey(id: string): string {
    return `agentMessageAccepted:${id}`;
  }
  private wasAccepted(id: string): boolean {
    return this.store.getSetting(this.acceptedKey(id), false);
  }
  private payload(id: string): MessagePayload | null {
    return this.store.getSetting(this.payloadKey(id), null);
  }

  /** Schedule delivery after commit; never wait for a recipient from an agent request. */
  wake(): void {
    if (!this.running) return;
    queueMicrotask(() => {
      if (this.running)
        void this.deliverPending().catch((error) =>
          this.store.hub.onListenerError("messages", error),
        );
    });
  }
}

function payloadKey(id: string): string {
  return `agentMessagePayload:${id}`;
}

function getMessage(store: Store, id: string): AgentMessage | undefined {
  const row = store.st.get("SELECT * FROM agent_messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
  return row ? messageFromRow(row) : undefined;
}

export function captureCompletionMessage(
  store: Store,
  input: CompletionMessageInput,
): AgentMessage {
  return store.tx(() => {
    const existing = getMessage(store, input.id);
    if (existing) {
      if (
        existing.kind !== "completion" ||
        existing.senderSessionId !== input.senderSessionId ||
        existing.recipientSessionId !== input.recipientSessionId ||
        JSON.stringify(existing.body) !== JSON.stringify(input.body) ||
        store.getSetting<MessagePayload | null>(payloadKey(existing.id), null)?.text !== input.text
      ) {
        throw new SwitchyardError("conflict", "Completion message identity was reused.");
      }
      return existing;
    }
    return insertMessage(
      store,
      {
        ...input,
        kind: "completion",
        replyTo: null,
        chainId: input.id,
        depth: 0,
        requestedMode: "queue",
      },
      input.text,
    );
  });
}

function insertMessage(
  store: Store,
  input: Pick<
    AgentMessage,
    | "id"
    | "kind"
    | "senderSessionId"
    | "recipientSessionId"
    | "replyTo"
    | "chainId"
    | "depth"
    | "body"
    | "requestedMode"
    | "createdAt"
  >,
  text: string,
): AgentMessage {
  const holdUntil = new Date(Date.parse(input.createdAt) + MESSAGE_HOLD_MS).toISOString();
  // Enforce the sender contract by kind before insertion, not only on decoding.
  AgentMessage.parse({ ...input, seq: 1, deliveryState: "pending", holdUntil, readAt: null });
  store.st
    .get(`INSERT INTO agent_messages
      (id, kind, sender_session_id, recipient_session_id, reply_to, chain_id, depth, body_json,
       requested_mode, delivery_state, hold_until, read_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`)
    .run(
      input.id,
      input.kind,
      input.senderSessionId,
      input.recipientSessionId,
      input.replyTo,
      input.chainId,
      input.depth,
      JSON.stringify(input.body),
      input.requestedMode,
      holdUntil,
      input.createdAt,
      input.createdAt,
    );
  store.setSetting(payloadKey(input.id), {
    deliveryId: input.id,
    kind: input.kind,
    text,
  } satisfies MessagePayload);
  store.afterCommit(() => store.hub.emit("messages.pending"));
  return getMessage(store, input.id)!;
}

function messageFromRow(row: MessageRow): AgentMessage {
  return AgentMessage.parse({
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    senderSessionId: row.sender_session_id,
    recipientSessionId: row.recipient_session_id,
    replyTo: row.reply_to,
    chainId: row.chain_id,
    depth: row.depth,
    body: JSON.parse(row.body_json),
    requestedMode: row.requested_mode,
    deliveryState: row.delivery_state,
    holdUntil: row.hold_until,
    readAt: row.read_at,
    createdAt: row.created_at,
  });
}
