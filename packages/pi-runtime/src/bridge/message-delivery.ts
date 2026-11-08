import { createHash } from "node:crypto";
import { type AgentChannel, type BridgeCommandHeader, channelError } from "./agent-channel.js";

type Attempt = { id: string; runtimeId: string; nativeSessionId: string };
type Offer = {
  deliveryId: string;
  kind: "message" | "completion";
  text: string;
  mode: "steer" | "queue";
  holdUntil: string;
};
type Evidence = {
  deliveryId: string;
  attempt: Attempt;
  state: "not_seen" | "held" | "queued" | "appended" | "uncertain";
  proof: "live_memory" | "native_entry" | "none";
  safeToRetry: boolean;
  reason: "draft" | "dialog" | "effect_unknown" | null;
  effectiveMode: "steer" | "queue" | null;
  entryId: string | null;
};
type Known = { hash: string; evidence: Evidence };

export function createMessageDelivery(
  pi: any,
  options: {
    channel: AgentChannel;
    getContext: () => any | null;
    isDialogOpen: () => boolean;
    mode: "rpc" | "terminal";
    now?: () => number;
  },
): { close(): void } {
  const known = new Map<string, Known>();
  const locks = new Map<string, Promise<unknown>>();
  const now = options.now ?? Date.now;
  let closed = false;
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
  const validAttempt = (a: any): a is Attempt =>
    a &&
    typeof a.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.id) &&
    id(a.runtimeId) &&
    id(a.nativeSessionId);
  const fence = (envelope: BridgeCommandHeader, requireReady = false) => {
    const c = options.channel.snapshot().configuration;
    if (
      closed ||
      !c ||
      c.runtimeId !== envelope.runtimeId ||
      c.nativeSessionId !== envelope.nativeSessionId ||
      c.bindingId !== envelope.bindingId
    )
      throw channelError("conflict", "Obsolete delivery binding");
    if (requireReady && !c.coordinatorConnected)
      throw channelError("host_unreachable", "Coordinator is disconnected");
  };
  const evidence = (
    deliveryId: string,
    attempt: Attempt,
    state: Evidence["state"],
    proof: Evidence["proof"],
    safeToRetry: boolean,
    reason: Evidence["reason"] = null,
    effectiveMode: Evidence["effectiveMode"] = null,
    entryId: string | null = null,
  ): Evidence => ({
    deliveryId,
    attempt,
    state,
    proof,
    safeToRetry,
    reason,
    effectiveMode,
    entryId,
  });
  const native = (deliveryId: string, hash: string, attempt: Attempt): Evidence | null => {
    const entries = options.getContext()?.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries) {
      const m =
        entry?.type === "custom_message"
          ? (entry.message ?? entry)
          : entry?.type === "message"
            ? entry.message
            : null;
      if (
        (m?.customType === "switchyard-inbox" || m?.customType === "switchyard-completion") &&
        m.details?.version === 1 &&
        m.details.deliveryId === deliveryId &&
        id(m.details.attemptId) &&
        typeof m.details.offerHash === "string"
      ) {
        if (m.details.offerHash !== hash)
          throw channelError("conflict", "Delivery offer hash changed");
        return evidence(
          deliveryId,
          attempt,
          "appended",
          "native_entry",
          false,
          null,
          null,
          entry.id ?? null,
        );
      }
    }
    return null;
  };
  const serial = <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(key, next);
    void next
      .finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      })
      .catch(() => {});
    return next;
  };
  const validate = (args: any) => {
    if (
      !args ||
      !id(args.deliveryId) ||
      typeof args.offerHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(args.offerHash) ||
      !validAttempt(args.attempt)
    )
      throw channelError("invalid_request", "Invalid delivery status");
    const old = known.get(args.deliveryId);
    if (old && old.hash !== args.offerHash)
      throw channelError("conflict", "Delivery offer hash changed");
  };
  const status = (args: any, envelope: BridgeCommandHeader): Evidence => {
    validate(args);
    fence(envelope);
    const found = native(args.deliveryId, args.offerHash, args.attempt);
    if (found) {
      known.set(args.deliveryId, { hash: args.offerHash, evidence: found });
      return found;
    }
    const old = known.get(args.deliveryId);
    if (old && old.evidence.state !== "not_seen") return { ...old.evidence, attempt: args.attempt };
    const result =
      args.attempt.runtimeId === envelope.runtimeId &&
      args.attempt.nativeSessionId === envelope.nativeSessionId
        ? evidence(args.deliveryId, args.attempt, "not_seen", "live_memory", true)
        : evidence(args.deliveryId, args.attempt, "uncertain", "none", false, "effect_unknown");
    known.set(args.deliveryId, { hash: args.offerHash, evidence: result });
    return result;
  };
  const removeStatus = options.channel.registerCommand("delivery.status", (raw, envelope) => {
    const args = raw as any;
    return serial(args?.deliveryId ?? "", () => status(args, envelope));
  });
  const removeAccept = options.channel.registerCommand("delivery.accept", (raw, envelope) => {
    const args = raw as any;
    const offer: Offer = args?.offer;
    return serial(offer?.deliveryId ?? "", () => {
      if (
        !offer ||
        !id(offer.deliveryId) ||
        !["message", "completion"].includes(offer.kind) ||
        typeof offer.text !== "string" ||
        Buffer.byteLength(offer.text, "utf8") > 65536 ||
        !["steer", "queue"].includes(offer.mode) ||
        typeof offer.holdUntil !== "string" ||
        !Number.isFinite(Date.parse(offer.holdUntil)) ||
        new Date(offer.holdUntil).toISOString() !== offer.holdUntil ||
        Buffer.byteLength(JSON.stringify(offer), "utf8") > 98304
      )
        throw channelError("invalid_request", "Invalid delivery offer");
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            1,
            offer.deliveryId,
            offer.kind,
            offer.text,
            offer.mode,
            offer.holdUntil,
          ]),
        )
        .digest("hex");
      if (hash !== args.offerHash) throw channelError("conflict", "Delivery offer hash mismatch");
      const query = { deliveryId: offer.deliveryId, offerHash: hash, attempt: args.attempt };
      const existing = status(query, envelope);
      if (
        existing.state === "appended" ||
        existing.state === "queued" ||
        existing.state === "uncertain"
      )
        return existing;
      if (
        args.attempt.runtimeId !== envelope.runtimeId ||
        args.attempt.nativeSessionId !== envelope.nativeSessionId
      )
        throw channelError("conflict", "Delivery attempt identity mismatch");
      fence(envelope);
      const ctx = options.getContext();
      const idle = ctx?.isIdle?.();
      const expired = now() >= Date.parse(offer.holdUntil);
      const dialog = options.isDialogOpen();
      const draft = options.mode === "terminal" && !!ctx?.ui?.getEditorText?.();
      // Guard/context reads may expose a changed binding or connection. Recheck after them;
      // keep this final readiness/identity fence synchronous through the send invocation.
      fence(envelope, true);
      if (!expired && (dialog || draft)) {
        const result = evidence(
          offer.deliveryId,
          args.attempt,
          "held",
          "live_memory",
          true,
          dialog ? "dialog" : "draft",
        );
        known.set(offer.deliveryId, { hash, evidence: result });
        return result;
      }
      const mode = expired ? "queue" : offer.mode;
      const uncertain = evidence(
        offer.deliveryId,
        args.attempt,
        "uncertain",
        "live_memory",
        false,
        "effect_unknown",
        mode,
      );
      known.set(offer.deliveryId, { hash, evidence: uncertain });
      try {
        pi.sendMessage(
          {
            customType: offer.kind === "message" ? "switchyard-inbox" : "switchyard-completion",
            content: offer.text,
            display: true,
            details: {
              version: 1,
              deliveryId: offer.deliveryId,
              offerHash: hash,
              attemptId: args.attempt.id,
            },
          },
          idle && !dialog && !draft && !expired
            ? { triggerTurn: true }
            : { deliverAs: mode === "steer" ? "steer" : "followUp" },
        );
      } catch {
        return uncertain;
      }
      const result =
        native(offer.deliveryId, hash, args.attempt) ??
        evidence(offer.deliveryId, args.attempt, "queued", "live_memory", false, null, mode);
      known.set(offer.deliveryId, { hash, evidence: result });
      return result;
    });
  });
  return {
    close() {
      closed = true;
      removeAccept();
      removeStatus();
    },
  };
}
