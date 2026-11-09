// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access tests private wiring without starting Pi.
import { EventEmitter } from "node:events";
import type { ManagedSession } from "@switchyard/pi-runtime";
import type { SessionStats } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import { HostDb } from "../src/db/index.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { type HostSessionRecord, SessionSupervisor } from "../src/supervisor.js";
import { mockProfile } from "./helpers.js";

const databases: HostDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const db = new HostDb(":memory:");
  db.migrate();
  databases.push(db);
  const emitted: Record<string, any>[] = [];
  const link = { emit: (event: { data: unknown }) => emitted.push(structuredClone(event.data)) };
  const supervisor = new SessionSupervisor({
    db,
    link: link as unknown as CoordinatorLink,
    hostId: "host",
    catalog: {} as AdapterCatalog,
    log: silentLogger(),
    pi: () => ({ compatible: true, reason: null }),
  });
  const rec: HostSessionRecord = {
    id: "session",
    title: "Session",
    subtitle: null,
    cwd: "/tmp",
    projectId: null,
    workspaceId: null,
    runId: null,
    taskId: null,
    dispatchKey: null,
    profile: mockProfile,
    nativeHandle: { sessionId: "native", sessionFile: "/tmp/native.jsonl" },
    runtime: "running",
    runtimeDetail: null,
    controlRevision: 1,
    controlMode: "human",
    origin: "human",
    readOnly: false,
    provenance: "created",
    nextOrder: 0,
    queue: { steering: [], followUp: [] },
    stats: { tokens: 10, costUsd: 0.1 },
    lastAssistantText: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  const process = Object.assign(new EventEmitter(), {
    isAlive: true,
    transport: "rpc",
    stats: vi.fn(),
  });
  const ms = process as unknown as ManagedSession;
  const live = supervisor["newLive"](rec);
  live.ms = ms;
  supervisor["live"].set(rec.id, live);
  supervisor["wire"](live, ms);
  const settle = () => {
    process.emit("runtime", { runtime: "idle", detail: null });
    process.emit("settled", { aborted: false, lastAssistantText: "Finished" });
  };
  return { db, rec, live, ms, process, supervisor, emitted, settle };
}

const totals = (tokens: number) => ({ tokens, costUsd: tokens / 100, context: null });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("completed settlement accounting", () => {
  it.each(["running", "waiting_input"] as const)(
    "holds %s until refreshed stats and idle commit together",
    async (runtime) => {
      const h = setup();
      h.process.emit("bridge_features", { runtimeId: "live-runtime", nativeSessionId: "native" });
      h.rec.runtime = runtime;
      const fresh = deferred<SessionStats>();
      h.process.stats.mockReturnValue(fresh.promise);
      h.settle();
      // Incidental state changes cannot publish the deferred idle, even after a microtask.
      h.process.emit("queue", { steering: [], followUp: ["later"] });
      await flush();
      expect(h.rec.runtime).toBe(runtime);
      expect(h.emitted.every((event) => event.runtime === runtime)).toBe(true);
      fresh.resolve(totals(200));
      await flush();
      expect(h.rec.runtime).toBe("idle");
      const idle = h.emitted.filter((event) => event.runtime === "idle");
      expect(idle).toHaveLength(1);
      expect(idle[0]).toMatchObject({
        stats: { tokens: 200 },
        settled: { lastAssistantText: "Finished" },
      });
      expect(idle[0]!.stats.watermark).toEqual(idle[0]!.settled.watermark);
      expect(idle[0]!.stats.watermark).toEqual({
        runtimeId: h.live.accountingRuntimeId,
        settleSeq: 1,
      });
      expect(idle[0]!.stats.watermark.runtimeId).not.toBe("live-runtime");
      expect(
        h.db.getJson<HostSessionRecord>("SELECT json FROM sessions WHERE id = ?", [h.rec.id])
          ?.stats,
      ).toEqual(idle[0]!.stats);
    },
  );

  it.each(["failure", "timeout"])(
    "publishes missing evidence on %s and ignores late totals",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = setup();
      const fresh = deferred<SessionStats>();
      h.process.stats.mockReturnValue(fresh.promise);
      h.rec.stats = { ...totals(10), watermark: { runtimeId: "previous", settleSeq: 1 } };
      h.settle();
      if (mode === "failure") fresh.reject(new Error("unavailable"));
      else await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(h.rec.runtime).toBe("idle");
      expect(h.rec.stats).toEqual(totals(10));
      expect(h.emitted.at(-1)!.settled).not.toHaveProperty("watermark");
      fresh.resolve(totals(999));
      await flush();
      expect(h.rec.stats).toEqual(totals(10));
    },
  );

  it("fences an older settlement and best-effort read behind a newer settlement", async () => {
    const h = setup();
    const incidental = deferred<SessionStats>();
    const first = deferred<SessionStats>();
    const second = deferred<SessionStats>();
    h.process.stats
      .mockReturnValueOnce(incidental.promise)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const read = h.supervisor["refreshStats"](h.live);
    h.settle();
    h.process.emit("runtime", { runtime: "running", detail: null });
    h.settle();
    second.resolve(totals(300));
    await flush();
    const snapshot = structuredClone(h.rec.stats);
    expect(snapshot?.watermark?.settleSeq).toBe(2);
    first.resolve(totals(200));
    incidental.resolve(totals(100));
    await read;
    await flush();
    expect(h.rec.stats).toEqual(snapshot);
    expect(h.emitted.filter((event) => event.settled)).toHaveLength(1);
  });

  it.each(["native", "bridge", "bridge-native", "replacement", "exit"])(
    "fences pending stats after %s changes",
    async (change) => {
      const h = setup();
      h.process.emit("bridge_features", { runtimeId: "live-runtime", nativeSessionId: "native" });
      const first = deferred<SessionStats>();
      h.process.stats.mockReturnValue(first.promise);
      h.settle();
      if (change === "native")
        h.process.emit("native", { sessionId: "other", sessionFile: "/tmp/other.jsonl" });
      if (change === "bridge")
        h.process.emit("bridge_features", {
          runtimeId: "other-runtime",
          nativeSessionId: "native",
        });
      if (change === "bridge-native")
        h.process.emit("bridge_features", {
          runtimeId: "live-runtime",
          nativeSessionId: "other",
        });
      if (change === "replacement") h.supervisor["live"].delete(h.rec.id);
      if (change === "exit") h.process.emit("runtime", { runtime: "stopped", detail: null });
      const before = structuredClone(h.rec);
      first.resolve(totals(500));
      await flush();
      expect(h.rec).toEqual(before);
      expect(h.rec.stats).not.toHaveProperty("watermark");
    },
  );

  it.each(["success", "failure"])(
    "starts a fresh epoch and sequence after reattaching a %s snapshot",
    async (outcome) => {
      const h = setup();
      if (outcome === "success") h.process.stats.mockResolvedValue(totals(100));
      else h.process.stats.mockRejectedValue(new Error("No accounting"));
      h.settle();
      await flush();
      const persisted = h.db.getJson<HostSessionRecord>("SELECT json FROM sessions WHERE id = ?", [
        h.rec.id,
      ])!;
      const next = Object.assign(new EventEmitter(), {
        isAlive: true,
        transport: "rpc",
        stats: vi.fn().mockResolvedValue(totals(200)),
      });
      const live = h.supervisor["newLive"](persisted);
      expect(live.accountingRuntimeId).not.toBe(h.live.accountingRuntimeId);
      expect(live.settleSeq).toBe(0);
      expect(persisted.stats).not.toHaveProperty("watermark");
      live.ms = next as unknown as ManagedSession;
      h.supervisor["live"].set(h.rec.id, live);
      h.supervisor["wire"](live, live.ms);
      next.emit("bridge_features", {
        runtimeId: "same-surviving-bridge",
        nativeSessionId: "native",
      });
      next.emit("runtime", { runtime: "running", detail: null });
      next.emit("runtime", { runtime: "idle", detail: null });
      next.emit("settled", { aborted: false, lastAssistantText: "Reattached" });
      await flush();
      expect(persisted.stats?.watermark).toEqual({
        runtimeId: live.accountingRuntimeId,
        settleSeq: 1,
      });
      expect(persisted.stats?.watermark?.runtimeId).not.toBe("same-surviving-bridge");
    },
  );

  it("preserves freshness for context-only refreshes, not changed usage totals", async () => {
    const h = setup();
    h.process.stats.mockResolvedValue(totals(100));
    h.settle();
    await flush();
    const watermark = h.rec.stats?.watermark;
    const context = { tokens: 20, window: 1000, percent: 2 };
    h.process.stats.mockResolvedValue({ ...totals(100), context });
    await h.supervisor["refreshStats"](h.live);
    expect(h.rec.stats).toEqual({ ...totals(100), context, watermark });
    h.process.stats.mockResolvedValue(totals(200));
    await h.supervisor["refreshStats"](h.live);
    expect(h.rec.stats).toEqual(totals(200));
  });

  it("clears freshness on new work and safely publishes idle without a settled event", async () => {
    const h = setup();
    h.process.stats.mockResolvedValue(totals(100));
    h.settle();
    await flush();
    expect(h.rec.stats?.watermark).toBeDefined();
    h.process.emit("runtime", { runtime: "running", detail: null });
    expect(h.rec.stats).not.toHaveProperty("watermark");
    h.process.emit("runtime", { runtime: "idle", detail: null });
    await flush();
    expect(h.rec.runtime).toBe("idle");
    expect(h.emitted.at(-1)).not.toHaveProperty("settled");
    expect(h.emitted.at(-1)!.stats).not.toHaveProperty("watermark");
  });
});
