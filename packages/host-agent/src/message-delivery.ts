import { createHash, randomUUID } from "node:crypto";
import type {
  DeliveryAcceptArgs,
  DeliveryAttempt,
  DeliveryEvidence,
  DeliveryOffer,
  DeliveryStatusArgs,
} from "@switchyard/pi-runtime";
import { SwitchyardError } from "@switchyard/protocol";
import type { HostDb } from "./db/index.js";

export interface MessageDeliveryInput {
  sessionId: string;
  messageId: string;
  payload: { deliveryId: string; kind: "message" | "completion"; text: string };
  mode: "steer" | "queue";
  holdUntil: string;
}

// bridge-wire owns A.1's inferred host-side types; do not define another local wire contract.
export type {
  DeliveryAcceptArgs,
  DeliveryAttempt,
  DeliveryEvidence,
  DeliveryOffer,
  DeliveryStatusArgs,
};
export interface MessageDeliveryBinding {
  readonly runtimeId: string;
  readonly nativeSessionId: string;
  readonly bindingId: string;
}

/**
 * A configured, session-bound adapter, not native Pi RPC. Identity must be captured/immutable;
 * both methods must send under exactly this binding (never silently substitute a newer one).
 * status is a local read, including while coordinator connectivity is lost. accept requires
 * readiness. The transport must fence command/receipt headers to this runtime/native/binding.
 */
export interface MessageDeliveryBridge extends MessageDeliveryBinding {
  accept(args: DeliveryAcceptArgs, options: { signal: AbortSignal }): Promise<DeliveryEvidence>;
  status(args: DeliveryStatusArgs, options: { signal: AbortSignal }): Promise<DeliveryEvidence>;
}

export interface MessageDeliveryWorkerOptions {
  db: HostDb;
  /** Lookup only. Unconfigured, stopped, archived or unavailable sessions return null. */
  getBridge(sessionId: string): MessageDeliveryBridge | null;
  clock?: { now(): number };
  bridgeTimeoutMs?: number;
}

type State =
  | "accepted"
  | "applying"
  | "held"
  | "deferred"
  | "queued"
  | "appended"
  | "uncertain"
  | "failed";
interface Row {
  session_id: string;
  message_id: string;
  payload: string;
  requested_mode: MessageDeliveryInput["mode"];
  hold_until: string;
  offer_hash: string;
  attempt_id: string | null;
  attempt_runtime_id: string | null;
  attempt_native_session_id: string | null;
  effect_confirmed: number;
  next_attempt_at: string;
  state: State;
  reason: string | null;
  updated_at: string;
}
export interface MessageDeliveryStatus {
  messageId: string;
  /** applying is an internal claim, not a claim that Pi consumed the message. */
  state: Exclude<State, "applying">;
  attemptId: string | null;
  reason: string | null;
  updatedAt: string;
}

const RETRY_MS = 1000;
const BATCH_SIZE = 20;
const TERMINAL = new Set<State>(["appended", "failed"]);
const RECONCILE_ONLY = new Set<State>(["applying", "queued", "uncertain"]);
const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 200;
const sameAttempt = (a: DeliveryAttempt, b: DeliveryAttempt): boolean =>
  a.id === b.id && a.runtimeId === b.runtimeId && a.nativeSessionId === b.nativeSessionId;
const sameBinding = (a: MessageDeliveryBinding, b: MessageDeliveryBinding): boolean =>
  a.runtimeId === b.runtimeId &&
  a.nativeSessionId === b.nativeSessionId &&
  a.bindingId === b.bindingId;

/**
 * Durable jobs outside the supervisor event/prompt chain. The owner calls tick every second
 * and reconcile on reconnect/resume. No session is started/resumed here. One worker owns a DB;
 * await stop before closing it. No timer starts in the constructor.
 */
export class MessageDeliveryWorker {
  private readonly db: HostDb;
  private readonly clock: { now(): number };
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly options: MessageDeliveryWorkerOptions) {
    this.db = options.db;
    this.clock = options.clock ?? { now: Date.now };
    if (
      options.bridgeTimeoutMs !== undefined &&
      (!Number.isFinite(options.bridgeTimeoutMs) || options.bridgeTimeoutMs <= 0)
    ) {
      throw new Error("bridgeTimeoutMs must be finite and positive");
    }
    // A pre-enqueue claim is intent, not proof of an effect (or of its absence).
    const now = this.now();
    this.db.run(
      `UPDATE message_receipts SET state = 'uncertain', reason = 'effect_unknown',
       next_attempt_at = ?, updated_at = ? WHERE state = 'applying'`,
      [now, now],
    );
  }

  /** Quick durable acceptance. No Pi/network work or generic command-receipt dependency. */
  accept(input: MessageDeliveryInput): MessageDeliveryStatus {
    if (this.stopped) throw new Error("Message delivery worker is stopped");
    if (
      !input ||
      !validId(input.sessionId) ||
      !validId(input.messageId) ||
      !input.payload ||
      input.payload.deliveryId !== input.messageId ||
      !["message", "completion"].includes(input.payload.kind) ||
      typeof input.payload.text !== "string" ||
      Buffer.byteLength(input.payload.text, "utf8") > 64 * 1024 ||
      !["steer", "queue"].includes(input.mode) ||
      !Number.isFinite(Date.parse(input.holdUntil)) ||
      new Date(input.holdUntil).toISOString() !== input.holdUntil
    ) {
      throw new SwitchyardError("invalid_request", "Invalid message delivery");
    }
    const offer: DeliveryOffer = {
      deliveryId: input.messageId,
      kind: input.payload.kind,
      text: input.payload.text,
      mode: input.mode,
      holdUntil: input.holdUntil,
    };
    if (Buffer.byteLength(JSON.stringify(offer), "utf8") > 96 * 1024) {
      throw new SwitchyardError("invalid_request", "Message delivery offer exceeds 96 KiB");
    }
    const offerHash = createHash("sha256")
      .update(
        JSON.stringify([1, offer.deliveryId, offer.kind, offer.text, offer.mode, offer.holdUntil]),
      )
      .digest("hex");
    // Canonical known fields: key insertion order must not make a logical replay differ.
    const payload = JSON.stringify({
      deliveryId: offer.deliveryId,
      kind: offer.kind,
      text: offer.text,
    });
    return this.db.tx(() => {
      const existing = this.row(input.sessionId, input.messageId);
      if (existing) {
        if (existing.offer_hash !== offerHash) {
          throw new SwitchyardError(
            "conflict",
            "Message delivery ID reused with different content",
          );
        }
        return this.statusOf(existing);
      }
      const now = this.now();
      this.db.run(
        `INSERT INTO message_receipts
         (session_id, message_id, payload, requested_mode, hold_until, offer_hash,
          next_attempt_at, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        [
          input.sessionId,
          input.messageId,
          payload,
          input.mode,
          input.holdUntil,
          offerHash,
          now,
          now,
        ],
      );
      return this.statusOf(this.row(input.sessionId, input.messageId)!);
    });
  }

  /** session.messageStatus's fresh durable snapshot; never invokes the bridge. */
  getStatus(
    sessionId: string,
    messageIds: readonly string[],
  ): { messages: MessageDeliveryStatus[] } {
    return {
      messages: messageIds.flatMap((id) => {
        const row = this.row(sessionId, id);
        return row ? [this.statusOf(row)] : [];
      }),
    };
  }

  tick(): Promise<void> {
    return this.runBatch(false);
  }

  /** Wake jobs after host reconnect or explicit resume, without sliding hold deadlines. */
  reconcile(sessionId?: string): Promise<void> {
    return this.runBatch(true, sessionId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.inflight.values());
  }

  private async runBatch(wake: boolean, sessionId?: string): Promise<void> {
    // Never send a job whose acceptance/claim could still be rolled back by an outer tx.
    if (this.stopped || this.db.inTransaction) return;
    const busy = [...this.inflight.keys()];
    // Select one due job per session BEFORE the limit; a large inbox must not starve others.
    const rows = this.db.all<Row>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY session_id ORDER BY next_attempt_at, updated_at, message_id
         ) AS lane FROM message_receipts WHERE state NOT IN ('appended', 'failed')
         ${wake ? "" : "AND next_attempt_at <= ?"}
         ${sessionId === undefined ? "" : "AND session_id = ?"}
         ${busy.length ? `AND session_id NOT IN (${busy.map(() => "?").join(",")})` : ""}
       ) WHERE lane = 1
       ORDER BY next_attempt_at, updated_at, session_id, message_id LIMIT ?`,
      [
        ...(wake ? [] : [this.now()]),
        ...(sessionId === undefined ? [] : [sessionId]),
        ...busy,
        BATCH_SIZE,
      ],
    );
    const attempts: Promise<void>[] = [];
    for (const row of rows) {
      if (this.inflight.has(row.session_id)) continue;
      // Claim the lane before any adapter can re-enter tick/reconcile.
      const attempt = Promise.resolve()
        .then(() => this.attempt(row))
        .finally(() => this.inflight.delete(row.session_id));
      this.inflight.set(row.session_id, attempt);
      attempts.push(attempt);
    }
    await Promise.all(attempts);
  }

  private async attempt(selected: Row): Promise<void> {
    if (this.stopped || this.db.inTransaction) return;
    const row = this.row(selected.session_id, selected.message_id);
    if (!row || TERMINAL.has(row.state)) return;
    let bridge: MessageDeliveryBridge | null = null;
    try {
      bridge = this.options.getBridge(row.session_id);
    } catch {
      // Lookup did not send anything.
    }
    if (!bridge) {
      this.record(row, RECONCILE_ONLY.has(row.state) ? row.state : "deferred");
      return;
    }
    // Capture identity even if an incorrect adapter later mutates its public properties.
    const binding: MessageDeliveryBinding = {
      runtimeId: bridge.runtimeId,
      nativeSessionId: bridge.nativeSessionId,
      bindingId: bridge.bindingId,
    };
    if (!Object.values(binding).every(validId)) {
      this.record(row, RECONCILE_ONLY.has(row.state) ? row.state : "deferred");
      return;
    }
    if (RECONCILE_ONLY.has(row.state)) {
      const attempt = this.previousAttempt(row);
      if (!attempt) {
        this.record(row, "uncertain");
        return;
      }
      try {
        const result = await this.call((signal) => {
          this.assertCurrent(row.session_id, binding);
          return bridge.status(
            { deliveryId: row.message_id, offerHash: row.offer_hash, attempt },
            { signal },
          );
        });
        this.assertCurrent(row.session_id, binding);
        this.validateEvidence(result, row.message_id, attempt, binding, true);
        if (result.state === "held" || result.state === "not_seen") {
          // Once a live invocation was confirmed, contradictory absence can never authorize replay.
          if (row.effect_confirmed) {
            this.record(row, "uncertain");
            return;
          }
          await this.send(row, bridge, binding);
        } else {
          this.record(row, result.state, result);
        }
      } catch {
        this.record(row, "uncertain");
      }
      return;
    }
    // Pending without an attempt, or a durably confirmed no-effect hold, is first-safe.
    await this.send(row, bridge, binding);
  }

  private async send(
    row: Row,
    bridge: MessageDeliveryBridge,
    binding: MessageDeliveryBinding,
  ): Promise<void> {
    // getBridge may have changed while a status response was in flight. No new attempt/effect
    // is authorized by a receipt from an obsolete binding.
    try {
      this.assertCurrent(row.session_id, binding);
    } catch {
      this.record(row, RECONCILE_ONLY.has(row.state) ? "uncertain" : "deferred");
      return;
    }
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      runtimeId: binding.runtimeId,
      nativeSessionId: binding.nativeSessionId,
    };
    const now = this.now();
    const claimed = this.db.run(
      `UPDATE message_receipts SET state = 'applying', attempt_id = ?, attempt_runtime_id = ?,
       attempt_native_session_id = ?, claimed_at = ?, result_json = NULL, reason = NULL, updated_at = ?
       WHERE session_id = ? AND message_id = ? AND attempt_id IS ? AND state = ?`,
      [
        attempt.id,
        attempt.runtimeId,
        attempt.nativeSessionId,
        now,
        now,
        row.session_id,
        row.message_id,
        row.attempt_id,
        row.state,
      ],
    );
    if (!claimed.changes) return;
    const applying: Row = {
      ...row,
      state: "applying",
      attempt_id: attempt.id,
      attempt_runtime_id: attempt.runtimeId,
      attempt_native_session_id: attempt.nativeSessionId,
    };
    try {
      const result = await this.call((signal) => {
        this.assertCurrent(row.session_id, binding);
        return bridge.accept(
          {
            offer: {
              ...JSON.parse(row.payload),
              mode: row.requested_mode,
              holdUntil: row.hold_until,
            },
            offerHash: row.offer_hash,
            attempt,
          },
          { signal },
        );
      });
      this.assertCurrent(row.session_id, binding);
      this.validateEvidence(result, row.message_id, attempt, binding, false);
      if (result.state === "not_seen") throw new Error("accept cannot prove not_seen");
      this.record(applying, result.state, result);
    } catch {
      // Timeout, disconnect, invalid/old receipts and stop all leave an ambiguous attempt.
      this.record(applying, "uncertain");
    }
  }

  private assertCurrent(sessionId: string, binding: MessageDeliveryBinding): void {
    const current = this.options.getBridge(sessionId);
    if (this.stopped || !current || !sameBinding(current, binding)) {
      throw new Error("Message delivery binding is obsolete");
    }
  }

  private validateEvidence(
    evidence: DeliveryEvidence,
    deliveryId: string,
    attempt: DeliveryAttempt,
    binding: MessageDeliveryBinding,
    status: boolean,
  ): void {
    if (
      !evidence ||
      evidence.deliveryId !== deliveryId ||
      !evidence.attempt ||
      !sameAttempt(evidence.attempt, attempt) ||
      ![null, "steer", "queue"].includes(evidence.effectiveMode)
    ) {
      throw new Error("Mismatched delivery evidence");
    }
    const sameLiveIdentity =
      attempt.runtimeId === binding.runtimeId &&
      attempt.nativeSessionId === binding.nativeSessionId;
    let valid = false;
    switch (evidence.state) {
      case "appended":
        valid =
          evidence.proof === "native_entry" &&
          evidence.safeToRetry === false &&
          validId(evidence.entryId) &&
          evidence.reason === null;
        break;
      case "queued":
        valid =
          sameLiveIdentity &&
          evidence.proof === "live_memory" &&
          evidence.safeToRetry === false &&
          evidence.entryId === null &&
          evidence.reason === null &&
          evidence.effectiveMode !== null;
        break;
      case "held":
        valid =
          sameLiveIdentity &&
          evidence.proof === "live_memory" &&
          evidence.safeToRetry === true &&
          evidence.entryId === null &&
          evidence.effectiveMode === null &&
          (evidence.reason === "draft" || evidence.reason === "dialog");
        break;
      case "not_seen":
        valid =
          status &&
          evidence.proof === "live_memory" &&
          evidence.safeToRetry === true &&
          evidence.entryId === null &&
          evidence.effectiveMode === null &&
          evidence.reason === null &&
          sameLiveIdentity;
        break;
      case "uncertain":
        valid =
          (evidence.proof === "none" || evidence.proof === "live_memory") &&
          evidence.safeToRetry === false &&
          evidence.entryId === null &&
          evidence.reason === "effect_unknown";
        break;
    }
    if (!valid) throw new Error("Invalid delivery evidence");
  }

  private previousAttempt(row: Row): DeliveryAttempt | null {
    return row.attempt_id && row.attempt_runtime_id && row.attempt_native_session_id
      ? {
          id: row.attempt_id,
          runtimeId: row.attempt_runtime_id,
          nativeSessionId: row.attempt_native_session_id,
        }
      : null;
  }

  private record(row: Row, state: State, result?: DeliveryEvidence): void {
    const now = this.clock.now();
    this.db.run(
      `UPDATE message_receipts SET state = ?, result_json = COALESCE(?, result_json), reason = ?,
       effect_confirmed = MAX(effect_confirmed, ?), next_attempt_at = ?, updated_at = ?
       WHERE session_id = ? AND message_id = ? AND attempt_id IS ? AND state = ?`,
      [
        state,
        result ? JSON.stringify(result) : null,
        state === "uncertain" ? "effect_unknown" : result ? result.reason : row.reason,
        state === "queued" || state === "appended" ? 1 : 0,
        new Date(now + RETRY_MS).toISOString(),
        new Date(now).toISOString(),
        row.session_id,
        row.message_id,
        row.attempt_id,
        row.state,
      ],
    );
  }

  private row(sessionId: string, messageId: string): Row | undefined {
    return this.db.get<Row>(
      "SELECT * FROM message_receipts WHERE session_id = ? AND message_id = ?",
      [sessionId, messageId],
    );
  }

  private statusOf(row: Row): MessageDeliveryStatus {
    return {
      messageId: row.message_id,
      state: row.state === "applying" ? "accepted" : row.state,
      attemptId: row.attempt_id,
      reason: row.reason,
      updatedAt: row.updated_at,
    };
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Bound even an adapter ignoring AbortSignal; late receipts cannot update durable state. */
  private async call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.bridgeTimeoutMs ?? 30_000);
    try {
      return await new Promise<T>((resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Delivery interrupted")),
          { once: true },
        );
        Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return fn(controller.signal);
          })
          .then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
}
