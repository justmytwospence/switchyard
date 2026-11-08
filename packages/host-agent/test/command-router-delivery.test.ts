import { join } from "node:path";
import type { HostCommand } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  type CommandRouterOptions,
  queueKey,
  READ_ONLY_COMMANDS,
  RESTARTED_WHILE_RUNNING,
} from "../src/commands.js";
import { type HostDb, openHostDb } from "../src/db/index.js";
import { silentLogger } from "../src/logger.js";
import { MessageDeliveryWorker } from "../src/message-delivery.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const command = {
  type: "session.deliverMessage",
  sessionId: "s1",
  messageId: "m1",
  payload: { deliveryId: "m1", kind: "message", text: "[Switchyard message m1]" },
  mode: "steer",
  holdUntil: "2026-01-01T00:10:00.000Z",
} satisfies HostCommand;
const commandId = "msg_m1";
const clock = { now: () => Date.parse("2026-01-01T00:00:00.000Z") };

function makeRouter(
  db: HostDb,
  delivery: NonNullable<CommandRouterOptions["delivery"]>,
  supervisor: object = { record: () => ({ id: "s1" }) },
) {
  return new CommandRouter({
    db,
    delivery,
    supervisor: supervisor as CommandRouterOptions["supervisor"],
    dispatcher: {} as CommandRouterOptions["dispatcher"],
    workspaces: {} as CommandRouterOptions["workspaces"],
    log: silentLogger(),
    sendReceipt: vi.fn(),
  });
}

function fixture() {
  const dir = tempDir();
  let db = openHostDb(join(dir.path, "host.db"));
  db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", ["s1", '{"id":"s1"}']);
  const getBridge = vi.fn(() => null);
  let worker = new MessageDeliveryWorker({ db, getBridge, clock });
  let router = makeRouter(db, worker);
  cleanups.push(async () => {
    await worker.stop();
    db.close();
    dir.cleanup();
  });
  return {
    get db() {
      return db;
    },
    get worker() {
      return worker;
    },
    get router() {
      return router;
    },
    getBridge,
    async restart() {
      await worker.stop();
      db.close();
      db = openHostDb(join(dir.path, "host.db"));
      worker = new MessageDeliveryWorker({ db, getBridge, clock });
      router = makeRouter(db, worker);
    },
    job() {
      return db.get("SELECT * FROM message_receipts WHERE session_id = ? AND message_id = ?", [
        command.sessionId,
        command.messageId,
      ]);
    },
  };
}

function pending(db: HostDb, id: string, type?: string) {
  db.run("INSERT INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)", [
    id,
    JSON.stringify({ commandId: id, pending: true, type }),
    new Date(clock.now()).toISOString(),
  ]);
}

describe("CommandRouter durable message acceptance", () => {
  it("keeps acceptance on the message lane, independent of a blocked prompt and Pi effects", async () => {
    const f = fixture();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prompt = vi.fn(() => {
      entered();
      return gate;
    });
    const reconcile = vi.spyOn(f.worker, "reconcile");
    const accept = vi.spyOn(f.worker, "accept");
    const r = makeRouter(f.db, f.worker, { record: () => ({ id: "s1" }), prompt });
    expect(READ_ONLY_COMMANDS.has(command.type)).toBe(false);
    expect(queueKey(command)).toBe("message:s1");
    const running = r.handle("prompt", {
      type: "session.prompt",
      sessionId: "s1",
      text: "wait",
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await started;
    try {
      const accepted = await r.handle(commandId, command);
      expect(accepted).toMatchObject({ ok: true, result: { state: "accepted" } });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
      expect(f.getBridge).not.toHaveBeenCalled();
      const status = await r.handle("status", {
        type: "session.messageStatus",
        sessionId: "s1",
        messageIds: ["m1"],
      });
      expect(status).toMatchObject({ ok: true, result: { messages: [{ state: "accepted" }] } });
      expect(f.getBridge).not.toHaveBeenCalled();
    } finally {
      finish();
      await running;
    }
  });

  for (const boundary of ["before job insert", "after job insert"] as const) {
    for (const legacyMarker of [false, true]) {
      it(`recovers a crash ${boundary}${legacyMarker ? " with a legacy pending marker" : ""}`, async () => {
        const f = fixture();
        if (legacyMarker) pending(f.db, commandId, command.type);
        const run = f.db.run.bind(f.db);
        const crash = new Error("simulated process crash");
        let crashed = false;
        const writes = vi.spyOn(f.db, "run").mockImplementation((sql, params) => {
          const boundaryReached =
            boundary === "before job insert"
              ? sql.includes("INSERT INTO message_receipts")
              : sql.includes("INSERT OR REPLACE INTO receipts");
          if (boundaryReached) crashed = true;
          // Once the process dies, even the generic error-receipt write cannot happen.
          if (crashed) throw crash;
          return run(sql, params);
        });
        await expect(f.router.handle(commandId, command)).rejects.toBe(crash);
        expect(crashed).toBe(true);
        // Rerunnable acceptance must not create another generic pending marker.
        expect(
          writes.mock.calls.some(([sql]) => sql.includes("INSERT OR REPLACE INTO receipts")),
        ).toBe(true);
        const before = f.job();
        if (boundary === "before job insert") expect(before).toBeUndefined();
        else expect(before).toMatchObject({ state: "accepted", hold_until: command.holdUntil });
        expect(f.getBridge).not.toHaveBeenCalled();
        writes.mockRestore();
        await f.restart();
        const reconcile = vi.spyOn(f.worker, "reconcile");
        expect(f.router.recoverPending()).toBe(legacyMarker ? 1 : 0);
        expect(
          f.db.get("SELECT * FROM receipts WHERE command_id = ?", [commandId]),
        ).toBeUndefined();
        const accepted = await f.router.handle(commandId, command);
        expect(accepted).toMatchObject({ ok: true, result: { state: "accepted" } });
        expect(f.db.all("SELECT * FROM message_receipts")).toHaveLength(1);
        if (before) expect(f.job()).toEqual(before);
        expect(f.job()).toMatchObject({ hold_until: command.holdUntil, attempt_id: null });
        const accept = vi.spyOn(f.worker, "accept");
        expect(await f.router.handle(commandId, command)).toEqual(accepted);
        expect(accept).not.toHaveBeenCalled(); // Completed generic receipts still replay.
        expect(reconcile).not.toHaveBeenCalled();
        expect(f.getBridge).not.toHaveBeenCalled();
      });
    }
  }

  for (const state of ["applying", "uncertain"] as const) {
    it(`reaccepts an existing ${state} job without resetting its attempt or authorizing enqueue`, async () => {
      const f = fixture();
      f.worker.accept(command);
      f.db.run(
        `UPDATE message_receipts SET state = ?, attempt_id = 'attempt-1',
         attempt_runtime_id = 'runtime-1', attempt_native_session_id = 'native-1',
         claimed_at = ?, next_attempt_at = ?, reason = 'effect_unknown',
         result_json = '{"state":"uncertain"}' WHERE message_id = 'm1'`,
        [state, "2026-01-01T00:01:00.000Z", "2026-01-01T00:02:00.000Z"],
      );
      const before = f.job();
      pending(f.db, commandId, command.type);
      const reconcile = vi.spyOn(f.worker, "reconcile");
      expect(f.router.recoverPending()).toBe(1);
      const receipt = await f.router.handle(commandId, command);
      expect(receipt).toMatchObject({
        ok: true,
        result: { state: state === "applying" ? "accepted" : "uncertain", attemptId: "attempt-1" },
      });
      expect(f.job()).toEqual(before);
      // Dedupe survives generic receipt pruning, including a replay of the same command ID.
      f.db.run("DELETE FROM receipts");
      expect(await f.router.handle(commandId, command)).toEqual(receipt);
      expect(f.job()).toEqual(before);
      expect(reconcile).not.toHaveBeenCalled();
      expect(f.getBridge).not.toHaveBeenCalled();
      await f.restart();
      expect(f.job()).toMatchObject({
        state: "uncertain",
        attempt_id: "attempt-1",
        attempt_runtime_id: "runtime-1",
        attempt_native_session_id: "native-1",
        hold_until: command.holdUntil,
      });
      const restarted = f.job();
      f.db.run("DELETE FROM receipts");
      expect(await f.router.handle(commandId, command)).toMatchObject({
        ok: true,
        result: { state: "uncertain", attemptId: "attempt-1" },
      });
      expect(f.job()).toEqual(restarted);
      expect(f.getBridge).not.toHaveBeenCalled();
    });
  }

  it("discards only exact pending delivery markers, preserving unrelated restarted errors and completed receipts", async () => {
    const f = fixture();
    pending(f.db, commandId, command.type);
    for (const [id, type] of [
      ["prompt", "session.prompt"],
      ["similar", "session.deliverMessage.extra"],
      ["missing", undefined],
    ]) {
      pending(f.db, id!, type);
    }
    const completed = { commandId: "completed", ok: true, result: { state: "accepted" } };
    f.db.run("INSERT INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)", [
      "completed",
      JSON.stringify(completed),
      new Date(clock.now()).toISOString(),
    ]);
    expect(f.router.recoverPending()).toBe(4);
    expect(f.router.storedReceipt(commandId)).toBeUndefined();
    for (const id of ["prompt", "similar", "missing"]) {
      expect(f.router.storedReceipt(id)).toMatchObject({
        ok: false,
        error: { code: "internal", message: RESTARTED_WHILE_RUNNING },
      });
    }
    const accept = vi.spyOn(f.worker, "accept");
    expect(await f.router.handle("completed", command)).toEqual(completed);
    expect(accept).not.toHaveBeenCalled();
    expect(
      await f.router.handle("prompt", { type: "session.stop", sessionId: "s1" }),
    ).toMatchObject({
      ok: false,
      error: { message: RESTARTED_WHILE_RUNNING },
    });
    expect(f.router.recoverPending()).toBe(0);
  });
});
