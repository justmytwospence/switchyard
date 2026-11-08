import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostDb, MIGRATIONS, openHostDb } from "../src/db/index.js";
import {
  type DeliveryAttempt,
  type DeliveryEvidence,
  type MessageDeliveryBinding,
  type MessageDeliveryBridge,
  type MessageDeliveryInput,
  MessageDeliveryWorker,
} from "../src/message-delivery.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});

const identity: MessageDeliveryBinding = {
  runtimeId: "runtime-1",
  nativeSessionId: "native-1",
  bindingId: "binding-1",
};

function evidence(
  deliveryId: string,
  attempt: DeliveryAttempt,
  state: DeliveryEvidence["state"],
  changes: Partial<DeliveryEvidence> = {},
): DeliveryEvidence {
  return {
    deliveryId,
    attempt,
    state,
    proof: state === "appended" ? "native_entry" : state === "uncertain" ? "none" : "live_memory",
    safeToRetry: state === "not_seen" || state === "held",
    reason: state === "held" ? "draft" : state === "uncertain" ? "effect_unknown" : null,
    effectiveMode: state === "queued" ? "steer" : null,
    entryId: state === "appended" ? "entry-1" : null,
    ...changes,
  };
}

function fixture(file = ":memory:") {
  const db = openHostDb(file);
  cleanup.push(() => db.close());
  const seed = (id: string) =>
    db.run("INSERT OR IGNORE INTO sessions (id, json) VALUES (?, ?)", [id, JSON.stringify({ id })]);
  seed("s1");
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const accept = vi.fn<MessageDeliveryBridge["accept"]>(async ({ offer, attempt }) =>
    evidence(offer.deliveryId, attempt, "queued"),
  );
  const status = vi.fn<MessageDeliveryBridge["status"]>(async ({ deliveryId, attempt }) =>
    evidence(deliveryId, attempt, "uncertain"),
  );
  const bridge = { ...identity, accept, status };
  let available = true;
  const getBridge = vi.fn(() => (available ? bridge : null));
  const options = { db, clock, getBridge, bridgeTimeoutMs: 100 };
  let worker = new MessageDeliveryWorker(options);
  cleanup.push(() => worker.stop());
  const get = (id = "m1", sessionId = "s1") => worker.getStatus(sessionId, [id]).messages[0];
  return {
    db,
    bridge,
    clock,
    seed,
    get,
    getBridge,
    get worker() {
      return worker;
    },
    advance(ms = 1000) {
      now += ms;
    },
    offline() {
      available = false;
    },
    online() {
      available = true;
    },
    state(id = "m1", sessionId = "s1") {
      return get(id, sessionId)?.state;
    },
    async restart() {
      await worker.stop();
      worker = new MessageDeliveryWorker(options);
    },
  };
}

function message(messageId = "m1", sessionId = "s1"): MessageDeliveryInput {
  return {
    sessionId,
    messageId,
    payload: { deliveryId: messageId, kind: "message", text: `[Switchyard message ${messageId}]` },
    mode: "steer",
    holdUntil: "2026-01-01T00:10:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Flush lane/bridge microtasks without real sleeps.
async function enteredBridge() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function loseAcceptance(f: ReturnType<typeof fixture>) {
  f.bridge.accept.mockRejectedValueOnce(new Error("socket lost after write"));
  f.worker.accept(message());
  await f.worker.tick();
  expect(f.state()).toBe("uncertain");
  return f.bridge.accept.mock.calls[0][0].attempt;
}

describe("host migration 003_agent_messages", () => {
  it("upgrades 002 once, preserving sessions and adding attempt/evidence storage", () => {
    const db = new HostDb(":memory:");
    cleanup.push(() => db.close());
    db.migrate(MIGRATIONS.filter((m) => m.name < "003"));
    const json = '{"id":"s1","runtime":"stopped"}';
    db.run("INSERT INTO sessions (id, json) VALUES ('s1', ?)", [json]);
    expect(db.migrate()).toEqual(["003_agent_messages"]);
    expect(db.migrate()).toEqual([]);
    expect(db.migrationLevel()).toBe("003_agent_messages");
    expect(db.get<{ json: string }>("SELECT json FROM sessions")?.json).toBe(json);
    const columns = db
      .all<{ name: string }>("PRAGMA table_info(message_receipts)")
      .map((r) => r.name);
    expect(columns).toEqual([
      "session_id",
      "message_id",
      "payload",
      "requested_mode",
      "hold_until",
      "offer_hash",
      "attempt_id",
      "attempt_runtime_id",
      "attempt_native_session_id",
      "effect_confirmed",
      "next_attempt_at",
      "state",
      "claimed_at",
      "result_json",
      "reason",
      "updated_at",
    ]);
    expect(
      db.get("SELECT name FROM sqlite_master WHERE name = 'message_receipts_due'"),
    ).toBeTruthy();
  });

  it("retains receipts outside generic receipt pruning, scoped to the owning session", () => {
    const f = fixture();
    f.seed("s2");
    f.worker.accept(message());
    f.worker.accept(message("m1", "s2"));
    f.db.run("DELETE FROM receipts");
    expect(f.worker.getStatus("s1", ["m1"]).messages).toHaveLength(1);
    expect(() => f.db.run("UPDATE message_receipts SET state = 'bogus'")).toThrow();
    expect(() => f.db.run("UPDATE message_receipts SET state = 'applying'")).toThrow();
    expect(() => f.db.run("UPDATE message_receipts SET attempt_id = 'partial'")).toThrow();
    expect(() =>
      f.db.run("UPDATE message_receipts SET offer_hash = ?", ["Z".repeat(64)]),
    ).toThrow();
    f.db.run("DELETE FROM sessions WHERE id = 's1'");
    expect(f.state()).toBeUndefined();
    expect(f.state("m1", "s2")).toBe("accepted");
  });
});

describe("MessageDeliveryWorker durable offers", () => {
  it("accepts without bridge contact and returns fresh structured status, not consumption", async () => {
    const f = fixture();
    expect(f.worker.accept(message())).toEqual({
      messageId: "m1",
      state: "accepted",
      attemptId: null,
      reason: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(f.getBridge).not.toHaveBeenCalled();
    expect(f.worker.getStatus("s1", ["missing", "m1"])).toEqual({ messages: [f.get()] });
    await f.worker.tick();
    expect(f.state()).toBe("queued");
    expect(f.worker.accept(message()).state).toBe("queued");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
    expect(f.bridge.status).not.toHaveBeenCalled();
  });

  it("uses the exact A.1 SHA256 tuple, flattened offer and immutable replay comparison", async () => {
    const f = fixture();
    const input = message();
    input.payload = { text: "Unicode: é\n", kind: "completion", deliveryId: "m1" };
    f.worker.accept(input);
    f.worker.accept({
      ...input,
      payload: { deliveryId: "m1", kind: "completion", text: input.payload.text },
    });
    for (const changed of [
      { ...input, payload: { ...input.payload, text: "changed" } },
      { ...input, payload: { ...input.payload, kind: "message" as const } },
      { ...input, mode: "queue" as const },
      { ...input, holdUntil: "2026-01-01T00:11:00.000Z" },
    ])
      expect(() => f.worker.accept(changed)).toThrow(/different content/);
    await f.worker.tick();
    expect(f.bridge.accept).toHaveBeenCalledWith(
      {
        offer: {
          deliveryId: "m1",
          kind: "completion",
          text: "Unicode: é\n",
          mode: "steer",
          holdUntil: input.holdUntil,
        },
        offerHash: createHash("sha256")
          .update(JSON.stringify([1, "m1", "completion", "Unicode: é\n", "steer", input.holdUntil]))
          .digest("hex"),
        attempt: {
          id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          runtimeId: "runtime-1",
          nativeSessionId: "native-1",
        },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("does not contact Pi within an outer transaction, including a rolled-back acceptance", async () => {
    const f = fixture();
    let tick!: Promise<void>;
    expect(() =>
      f.db.tx(() => {
        f.worker.accept(message());
        tick = f.worker.tick();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    await tick;
    expect(f.state()).toBeUndefined();
    expect(f.bridge.accept).not.toHaveBeenCalled();
  });

  it.each([
    { ...message(), payload: { ...message().payload, deliveryId: "other" } },
    { ...message(), holdUntil: "invalid" },
    { ...message(), holdUntil: "2026-01-01T00:10:00Z" },
    { ...message(), holdUntil: "2026-01-01T01:10:00.000+01:00" },
    { ...message(), payload: { ...message().payload, text: "é".repeat(32769) } },
    // Text fits 64 KiB but JSON escaping exceeds the serialized-offer limit.
    { ...message(), payload: { ...message().payload, text: "\u0000".repeat(20000) } },
  ])("rejects invalid/noncanonical/oversized input before persistence (%#)", (input) => {
    const f = fixture();
    expect(() => f.worker.accept(input)).toThrow(/Invalid|exceeds/);
    expect(f.state()).toBeUndefined();
  });

  it("accepts text at the UTF-8 limit without truncation", async () => {
    const f = fixture();
    const input = message();
    input.payload.text = "é".repeat(32768);
    f.worker.accept(input);
    await f.worker.tick();
    expect(f.bridge.accept.mock.calls[0][0].offer.text).toBe(input.payload.text);
  });
});

describe("MessageDeliveryWorker attempts and evidence", () => {
  it("persists the attempt and applying claim before invoking delivery.accept", async () => {
    const f = fixture();
    f.bridge.accept.mockImplementation(async ({ offer, attempt, offerHash }) => {
      expect(
        f.db.get(
          "SELECT state, attempt_id, attempt_runtime_id, attempt_native_session_id, offer_hash, claimed_at FROM message_receipts",
        ),
      ).toEqual({
        state: "applying",
        attempt_id: attempt.id,
        attempt_runtime_id: attempt.runtimeId,
        attempt_native_session_id: attempt.nativeSessionId,
        offer_hash: offerHash,
        claimed_at: "2026-01-01T00:00:00.000Z",
      });
      expect(f.state()).toBe("accepted");
      expect(f.get()?.attemptId).toBe(attempt.id);
      return evidence(offer.deliveryId, attempt, "queued");
    });
    f.worker.accept(message());
    await f.worker.tick();
    expect(f.state()).toBe("queued");
  });

  it("reconciles queued using status and only native-entry evidence means appended", async () => {
    const f = fixture();
    f.worker.accept(message());
    await f.worker.tick();
    const { attempt, offerHash } = f.bridge.accept.mock.calls[0][0];
    f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
      evidence(deliveryId, attempt, "appended"),
    );
    f.advance();
    await f.worker.tick();
    expect(f.bridge.status).toHaveBeenCalledWith(
      { deliveryId: "m1", offerHash, attempt },
      { signal: expect.any(AbortSignal) },
    );
    expect(f.get()).toMatchObject({ state: "appended", attemptId: attempt.id, reason: null });
    expect(
      JSON.parse(
        f.db.get<{ result_json: string }>("SELECT result_json FROM message_receipts")!.result_json,
      ),
    ).toEqual(evidence("m1", attempt, "appended"));
    await f.worker.reconcile();
    expect(f.bridge.accept).toHaveBeenCalledOnce();
    expect(f.bridge.status).toHaveBeenCalledOnce();
  });

  it("durable held proof survives restart and permits a new current-runtime attempt without sliding the hold", async () => {
    const f = fixture();
    f.bridge.accept.mockImplementationOnce(async ({ offer, attempt }) =>
      evidence(offer.deliveryId, attempt, "held", { reason: "dialog" }),
    );
    f.worker.accept(message());
    await f.worker.tick();
    const oldAttempt = f.get()!.attemptId;
    expect(f.get()).toMatchObject({ state: "held", reason: "dialog" });
    await f.restart();
    await f.worker.tick();
    expect(f.bridge.accept).toHaveBeenCalledOnce();
    Object.assign(f.bridge, {
      runtimeId: "runtime-2",
      nativeSessionId: "native-2",
      bindingId: "binding-2",
    });
    f.advance(10 * 60 * 1000);
    f.bridge.accept.mockImplementationOnce(async ({ offer, attempt }) =>
      evidence(offer.deliveryId, attempt, "queued", { effectiveMode: "queue" }),
    );
    await f.worker.tick();
    const args = f.bridge.accept.mock.calls[1][0];
    expect(args.attempt).toMatchObject({ runtimeId: "runtime-2", nativeSessionId: "native-2" });
    expect(args.attempt.id).not.toBe(oldAttempt);
    expect(args.offer.holdUntil).toBe(message().holdUntil);
    expect(args.offer.mode).toBe("steer"); // helper chooses effective queue, not a hash-changing host rewrite
    expect(args.offerHash).toBe(f.bridge.accept.mock.calls[0][0].offerHash);
    expect(f.get()).toMatchObject({ state: "queued", reason: null });
    expect(f.bridge.status).not.toHaveBeenCalled();
  });

  it("defers unavailable recipients even after expiry, without resuming them", async () => {
    const f = fixture();
    f.offline();
    f.worker.accept(message());
    f.advance(20 * 60 * 1000);
    await f.worker.tick();
    expect(f.state()).toBe("deferred");
    expect(f.bridge.accept).not.toHaveBeenCalled();
    f.online();
    await f.worker.reconcile("s1");
    expect(f.state()).toBe("queued");
    expect(f.bridge.accept.mock.calls[0][0].offer.holdUntil).toBe(message().holdUntil);
  });

  it.each(["not_seen", "held"] as const)(
    "recovers a lost receipt only after safe %s proof under the new binding",
    async (state) => {
      const f = fixture();
      const original = await loseAcceptance(f);
      await f.restart();
      f.bridge.bindingId = "binding-2"; // same still-live extension, fresh configure fences old commands
      f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) => {
        expect(attempt).toEqual(original);
        return evidence(deliveryId, attempt, state);
      });
      await f.worker.reconcile();
      const next = f.bridge.accept.mock.calls[1][0].attempt;
      expect(next.id).not.toBe(original.id);
      expect(next.runtimeId).toBe(original.runtimeId);
      expect(f.bridge.status.mock.invocationCallOrder[0]).toBeLessThan(
        f.bridge.accept.mock.invocationCallOrder[1],
      );
      expect(f.state()).toBe("queued");
    },
  );

  it("different runtime/native absence stays uncertain; later native-entry proof can reconcile", async () => {
    const f = fixture();
    const original = await loseAcceptance(f);
    Object.assign(f.bridge, {
      runtimeId: "runtime-2",
      nativeSessionId: "native-2",
      bindingId: "binding-2",
    });
    await f.restart();
    await f.worker.reconcile();
    expect(f.bridge.status.mock.calls[0][0].attempt).toEqual(original);
    expect(f.state()).toBe("uncertain");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
    f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
      evidence(deliveryId, attempt, "appended"),
    );
    await f.worker.reconcile();
    expect(f.state()).toBe("appended");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
  });

  it.each(["queued", "appended"] as const)(
    "recovers interrupted applying through %s evidence after reopening the database",
    async (state) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-messages-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, "host.db");
      const f = fixture(path);
      await loseAcceptance(f);
      f.db.run("UPDATE message_receipts SET state = 'applying'");
      await f.worker.stop();
      f.db.close();
      const db = openHostDb(path);
      cleanup.push(() => db.close());
      f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
        evidence(deliveryId, attempt, state),
      );
      const worker = new MessageDeliveryWorker({ db, clock: f.clock, getBridge: () => f.bridge });
      cleanup.push(() => worker.stop());
      expect(worker.getStatus("s1", ["m1"]).messages[0].state).toBe("uncertain");
      await worker.tick();
      expect(worker.getStatus("s1", ["m1"]).messages[0].state).toBe(state);
      expect(f.bridge.accept).toHaveBeenCalledOnce();
      expect(f.bridge.status).toHaveBeenCalledOnce();
    },
  );

  it.each(["queued", "held"] as const)(
    "rejects different-runtime live-memory %s evidence for an old attempt",
    async (state) => {
      const f = fixture();
      await loseAcceptance(f);
      Object.assign(f.bridge, { runtimeId: "runtime-2", bindingId: "binding-2" });
      f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
        evidence(deliveryId, attempt, state),
      );
      await f.worker.reconcile();
      expect(f.state()).toBe("uncertain");
      expect(f.bridge.accept).toHaveBeenCalledOnce();
    },
  );

  it("lost held acknowledgement is applying/uncertain and requires status before retry", async () => {
    const f = fixture();
    await loseAcceptance(f); // host cannot distinguish a lost held reply from a lost enqueue reply
    f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
      evidence(deliveryId, attempt, "held"),
    );
    await f.worker.reconcile();
    expect(f.bridge.status).toHaveBeenCalledOnce();
    expect(f.bridge.accept).toHaveBeenCalledTimes(2);
  });

  it.each(["not_seen", "held"] as const)(
    "never reaccepts a confirmed queued job, even after contradictory %s and restart",
    async (state) => {
      const f = fixture();
      f.worker.accept(message());
      await f.worker.tick();
      f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
        evidence(deliveryId, attempt, state),
      );
      await f.worker.reconcile();
      expect(f.state()).toBe("uncertain");
      await f.restart();
      await f.worker.reconcile();
      expect(f.state()).toBe("uncertain");
      expect(f.bridge.accept).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { deliveryId: "other" },
    { attempt: { id: "wrong", runtimeId: "runtime-1", nativeSessionId: "native-1" } },
    { state: "appended", proof: "live_memory", entryId: "intent-marker" },
    { state: "appended", proof: "native_entry", entryId: null },
    { state: "queued", safeToRetry: true },
    { state: "held", safeToRetry: false, reason: "draft" },
    { state: "not_seen", safeToRetry: true },
    { state: "bogus" },
  ])("rejects mismatched or invalid acceptance evidence (%#)", async (changes) => {
    const f = fixture();
    f.bridge.accept.mockImplementation(async ({ offer, attempt }) =>
      evidence(offer.deliveryId, attempt, "queued", changes as Partial<DeliveryEvidence>),
    );
    f.worker.accept(message());
    await f.worker.tick();
    expect(f.state()).toBe("uncertain");
    expect(f.get()?.reason).toBe("effect_unknown");
  });

  it.each(["runtime", "native", "unsafe", "no_proof"])(
    "rejects untrusted not_seen status proof: %s",
    async (kind) => {
      const f = fixture();
      await loseAcceptance(f);
      if (kind === "runtime") f.bridge.runtimeId = "runtime-2";
      if (kind === "native") f.bridge.nativeSessionId = "native-2";
      f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
        evidence(deliveryId, attempt, "not_seen", {
          ...(kind === "unsafe" ? { safeToRetry: false } : {}),
          ...(kind === "no_proof" ? { proof: "none" } : {}),
        }),
      );
      await f.worker.reconcile();
      expect(f.state()).toBe("uncertain");
      expect(f.bridge.accept).toHaveBeenCalledOnce();
    },
  );
});

describe("MessageDeliveryWorker fencing, scheduling and lifecycle", () => {
  it("discards a late old-binding accept receipt and queries the original attempt under the new binding", async () => {
    const f = fixture();
    const pending = deferred<DeliveryEvidence>();
    f.bridge.accept.mockReturnValueOnce(pending.promise);
    f.worker.accept(message());
    const tick = f.worker.tick();
    await enteredBridge();
    const { attempt } = f.bridge.accept.mock.calls[0][0];
    f.bridge.bindingId = "binding-2";
    pending.resolve(evidence("m1", attempt, "appended"));
    await tick;
    expect(f.state()).toBe("uncertain");
    await f.worker.reconcile();
    expect(f.bridge.status.mock.calls[0][0].attempt).toEqual(attempt);
    expect(f.bridge.accept).toHaveBeenCalledOnce();
  });

  it("does not authorize a retry from an old-binding delayed safe status receipt", async () => {
    const f = fixture();
    await loseAcceptance(f);
    const pending = deferred<DeliveryEvidence>();
    f.bridge.status.mockReturnValueOnce(pending.promise);
    const tick = f.worker.reconcile();
    await enteredBridge();
    const { attempt } = f.bridge.status.mock.calls[0][0];
    f.bridge.bindingId = "binding-2";
    pending.resolve(evidence("m1", attempt, "not_seen"));
    await tick;
    expect(f.state()).toBe("uncertain");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
  });

  it("does not contact an adapter whose binding rotated before the claim", async () => {
    const f = fixture();
    f.worker.accept(message());
    // First lookup captures binding-1. The next lookup discovers a newly configured binding.
    f.getBridge.mockReturnValueOnce({ ...f.bridge });
    f.bridge.bindingId = "binding-2";
    await f.worker.tick();
    expect(f.get()).toMatchObject({ state: "deferred", attemptId: null });
    expect(f.bridge.accept).not.toHaveBeenCalled();
    await f.worker.reconcile();
    expect(f.state()).toBe("queued");
  });

  it("fences stale writes by durable attempt id", async () => {
    const f = fixture();
    const pending = deferred<DeliveryEvidence>();
    f.bridge.accept.mockReturnValueOnce(pending.promise);
    f.worker.accept(message());
    const tick = f.worker.tick();
    await enteredBridge();
    const { attempt } = f.bridge.accept.mock.calls[0][0];
    f.db.run("UPDATE message_receipts SET attempt_id = 'replacement', state = 'uncertain'");
    pending.resolve(evidence("m1", attempt, "appended"));
    await tick;
    expect(f.get()).toMatchObject({ state: "uncertain", attemptId: "replacement" });
  });

  it("serializes each target across overlapping tick/reconcile, but not other sessions", async () => {
    const f = fixture();
    const pending = deferred<DeliveryEvidence>();
    f.seed("s2");
    f.worker.accept(message());
    f.worker.accept(message("m2"));
    f.worker.accept(message("m3", "s2"));
    f.bridge.accept.mockImplementation(async ({ offer, attempt }) =>
      offer.deliveryId === "m1" ? pending.promise : evidence(offer.deliveryId, attempt, "appended"),
    );
    const tick = f.worker.tick();
    await enteredBridge();
    await f.worker.reconcile();
    expect(f.bridge.accept).toHaveBeenCalledTimes(2);
    expect(f.state("m2")).toBe("accepted");
    expect(f.state("m3", "s2")).toBe("appended");
    pending.resolve(evidence("m1", f.bridge.accept.mock.calls[0][0].attempt, "queued"));
    await tick;
    expect(f.state()).toBe("queued");
  });

  it("caps a batch at 20 target lanes without a large inbox starving other sessions", async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) f.worker.accept(message(`backlog-${i}`));
    for (let i = 2; i <= 25; i++) {
      f.seed(`s${i}`);
      f.worker.accept(message(`m${i}`, `s${i}`));
    }
    f.bridge.accept.mockImplementation(async ({ offer, attempt }) =>
      evidence(offer.deliveryId, attempt, "appended"),
    );
    await f.worker.tick();
    expect(f.bridge.accept).toHaveBeenCalledTimes(20);
    expect(
      new Set(
        f.db
          .all<{ session_id: string }>(
            "SELECT session_id FROM message_receipts WHERE state = 'appended'",
          )
          .map((r) => r.session_id),
      ).size,
    ).toBe(20);
    await f.worker.tick();
    expect(f.bridge.accept).toHaveBeenCalledTimes(26); // five new targets plus the next s1 job
  });

  it("times out noncooperative adapters and ignores late receipts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = deferred<DeliveryEvidence>();
    f.bridge.accept.mockReturnValueOnce(pending.promise);
    f.worker.accept(message());
    const tick = f.worker.tick();
    await enteredBridge();
    const { attempt } = f.bridge.accept.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(100);
    await tick;
    expect(f.state()).toBe("uncertain");
    expect(f.bridge.accept.mock.calls[0][1].signal.aborted).toBe(true);
    pending.resolve(evidence("m1", attempt, "appended"));
    await enteredBridge();
    expect(f.state()).toBe("uncertain");
  });

  it("handles throwing availability lookup without sending and preserves ambiguous state", async () => {
    const f = fixture();
    f.worker.accept(message());
    f.getBridge.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await f.worker.tick();
    expect(f.state()).toBe("deferred");
    await f.worker.reconcile();
    f.offline();
    await f.worker.reconcile();
    expect(f.state()).toBe("queued");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
  });

  it("does not contact Pi when stopped before the scheduled lane begins", async () => {
    const f = fixture();
    f.worker.accept(message());
    const tick = f.worker.tick();
    await f.worker.stop();
    await tick;
    expect(f.state()).toBe("accepted");
    expect(f.bridge.accept).not.toHaveBeenCalled();
  });

  it("stop aborts in-flight work without hanging and recovery uses status first", async () => {
    const f = fixture();
    f.bridge.accept.mockImplementationOnce(() => new Promise(() => {}));
    f.worker.accept(message());
    const tick = f.worker.tick();
    await enteredBridge();
    await f.worker.stop();
    await tick;
    expect(f.state()).toBe("uncertain");
    expect(f.bridge.accept.mock.calls[0][1].signal.aborted).toBe(true);
    expect(() => f.worker.accept(message("m2"))).toThrow(/stopped/);
    await f.worker.tick();
    await f.worker.reconcile();
    expect(f.bridge.status).not.toHaveBeenCalled();
    await f.restart();
    f.bridge.status.mockImplementation(async ({ deliveryId, attempt }) =>
      evidence(deliveryId, attempt, "queued"),
    );
    await f.worker.reconcile();
    expect(f.state()).toBe("queued");
    expect(f.bridge.accept).toHaveBeenCalledOnce();
  });
});
