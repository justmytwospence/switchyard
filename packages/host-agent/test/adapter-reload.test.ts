// @module-tag slow
// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private supervisor wiring without bypassing reload guards.
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterRegistry, type ServerAdapter } from "@switchyard/adapter-sdk";
import type { ManagedSession } from "@switchyard/pi-runtime";
import { when } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import { HostDb } from "../src/db/index.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { type HostSessionRecord, SessionSupervisor } from "../src/supervisor.js";
import { type HostHarness, mockProfile, startCommand, startHarness, waitFor } from "./helpers.js";

let h: HostHarness | undefined;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await h?.dispose();
  h = undefined;
  delete (globalThis as any).__adapterGate;
});

function fixture(version: string) {
  const dir = join(h!.stateDir, "owner-adapters", "reload-fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify({
      id: "reload-fixture",
      version: "1.0.0",
      protocolVersion: 1,
      target: { extension: "fixture", versionRange: "*", testedVersions: [] },
      server: "server.mjs",
      webRenderer: null,
      capabilities: ["panels", "state"],
    }),
  );
  writeFileSync(
    join(dir, "server.mjs"),
    `export default {
    onRestore(ctx) { ctx.setPanel('version', {t:'text', text:'${version}'}); },
    onToolStart(e, ctx) { if (e.name === 'fixture_status') ctx.setPanel('historic', {t:'text', text:'tool'}); },
    onEntry(_e, ctx) { ctx.setPanel('replayed', {t:'text', text:'entry'}); },
    onAction: async (id) => { if (id === 'wait') await globalThis.__adapterGate; },
  };`,
  );
}

async function start(id = "ses_reload") {
  await h!.coord.ok(startCommand(id, h!.pi!.cwd));
  await waitFor(
    () =>
      !!h!.agent.supervisor.sessionAdapters(id).generation &&
      h!.agent.supervisor.sessionAdapters(id).reloadable,
    30000,
    "adapter startup",
  );
  return h!.agent.supervisor;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Real reload, registry, restore and event lanes; only Pi and catalog discovery are in memory. */
async function reloadRace() {
  const db = new HostDb(":memory:");
  db.migrate();
  const now = new Date().toISOString();
  const rec: HostSessionRecord = {
    id: "ses_race",
    title: "Reload race",
    subtitle: null,
    cwd: "/fixture",
    projectId: null,
    workspaceId: null,
    runId: null,
    taskId: null,
    dispatchKey: null,
    // Skip filesystem discovery, not readiness checks. The fake catalog supplies its registries.
    profile: { ...mockProfile, resources: "vanilla" },
    nativeHandle: { sessionId: "native", sessionFile: "/fixture/native.jsonl" },
    runtime: "idle",
    runtimeDetail: null,
    controlRevision: 1,
    controlMode: "human",
    origin: "human",
    readOnly: false,
    provenance: "created",
    nextOrder: 0,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    lastActivityAt: now,
    createdAt: now,
  };
  db.run("INSERT INTO sessions (id, json) VALUES (?, ?)", [rec.id, JSON.stringify(rec)]);
  const gate = deferred();
  const restoring = deferred();
  const registry = (server: ServerAdapter) => {
    const result = new AdapterRegistry();
    result.setAdapters([
      {
        manifest: {
          id: "race-fixture",
          version: "1.0.0",
          protocolVersion: 1,
          target: { extension: "fixture", versionRange: "*", testedVersions: [] },
          server: "server.mjs",
          webRenderer: null,
          capabilities: ["panels", "state"],
        },
        tier: "owner",
        dir: null,
        manifestPath: null,
        webRendererPath: null,
        server,
      },
    ]);
    return result;
  };
  const old = {
    registry: registry({
      onRestore(ctx) {
        ctx.setPanel("version", { t: "text", text: "old" });
      },
      onAction() {},
    }),
    commit: vi.fn(),
    dispose: vi.fn(),
  };
  const candidate = {
    registry: registry({
      async onRestore(ctx) {
        ctx.setPanel("version", { t: "text", text: "candidate" });
        ctx.state.set("candidate", "uncommitted");
        restoring.resolve();
        await gate.promise;
      },
    }),
    commit: vi.fn(),
    dispose: vi.fn(),
  };
  const catalog = {
    prepareSession: vi.fn().mockResolvedValueOnce(old).mockResolvedValue(candidate),
    sessionInfo: () => [],
    sessionDiagnostics: () => [],
    info: () => [],
    renderers: () => ({}),
    releaseSession() {},
  };
  const sup = new SessionSupervisor({
    db,
    link: { emit: vi.fn() } as unknown as CoordinatorLink,
    hostId: "hst_race",
    catalog: catalog as unknown as AdapterCatalog,
    log: silentLogger(),
    pi: () => ({ compatible: true, reason: null, version: "1.5.2" }),
  });
  const ms = Object.assign(new EventEmitter(), {
    isAlive: true,
    runtime: "idle",
    transport: "terminal",
    compacting: false,
    remoteDialogs: false,
    pendingDialogs: 0,
    bridgeFeatures: {
      runtimeId: "runtime-old",
      nativeSessionId: "native",
      capabilities: { resourceSnapshot: true },
    },
    resources: vi.fn(async () => ({
      cwd: rec.cwd,
      projectTrusted: true,
      reportedExtensionPaths: [],
      hasEditorDraft: false,
      pendingDialogs: ms.pendingDialogs,
    })),
  });
  const live = sup["newLive"](sup.record(rec.id)!);
  live.ms = ms as unknown as ManagedSession;
  // This fixture models an already-started runtime, not cold-start initialization.
  live.markStartReady();
  sup["live"].set(rec.id, live);
  sup["wire"](live, live.ms);
  ms.emit("bridge_features", ms.bridgeFeatures);
  cleanups.push(async () => {
    gate.resolve();
    await live.chain;
    sup["teardown"](live);
    db.close();
  });
  await sup["openAdapters"](live, rec.cwd);
  const original = {
    adapters: live.adapters,
    registry: live.registry,
    generation: live.rec.adapterGeneration,
    panels: sup.panels(rec.id),
  };
  const oldClose = vi.spyOn(live.adapters!, "close");
  const assertUnchanged = () => {
    expect(candidate.commit).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(oldClose).not.toHaveBeenCalled();
    expect(live.adapters).toBe(original.adapters);
    expect(live.registry).toBe(original.registry);
    expect(sup.record(rec.id)?.adapterGeneration).toBe(original.generation);
    expect(sup.panels(rec.id)).toEqual(original.panels);
    expect(db.get("SELECT * FROM adapter_state WHERE session_id = ?", [rec.id])).toBeUndefined();
  };
  return { sup, ms, live, gate, restoring, candidate, catalog, assertUnchanged };
}

describe("session adapter reload races", () => {
  it("does not authorize another workspace's project resources", async () => {
    const f = await reloadRace();
    const originalAdapters = f.live.adapters;
    const originalGeneration = f.live.rec.adapterGeneration;
    f.live.rec.profile = { ...f.live.rec.profile, resources: "all" };
    f.ms.resources.mockResolvedValue({
      cwd: "/another-workspace",
      projectTrusted: true,
      reportedExtensionPaths: [],
      hasEditorDraft: false,
      pendingDialogs: 0,
    });
    await expect(f.sup.reloadAdapters("ses_race")).rejects.toThrow(
      "Could not refresh Pi resources",
    );
    expect(f.catalog.prepareSession).toHaveBeenCalledTimes(1);
    expect(f.candidate.commit).not.toHaveBeenCalled();
    expect(f.candidate.dispose).not.toHaveBeenCalled();
    expect(f.live.adapters).toBe(originalAdapters);
    expect(f.live.rec.adapterGeneration).toBe(originalGeneration);
  });

  it("rejects a runtime replacement during restore without consuming its newer refresh marker", async () => {
    const f = await reloadRace();
    f.live.adapterRefreshPending = "runtime-old";
    const reload = f.sup.reloadAdapters("ses_race");
    const rejection = expect(reload).rejects.toThrow(
      "Pi changed while loading adapters; its current views are unchanged.",
    );
    await f.restoring.promise;
    // The newer Pi is busy, so the real scheduler must leave its refresh pending until idle.
    f.ms.runtime = "running";
    f.ms.emit("runtime", { runtime: "running", detail: null });
    f.ms.bridgeFeatures = { ...f.ms.bridgeFeatures, runtimeId: "runtime-new" };
    f.ms.emit("bridge_features", f.ms.bridgeFeatures);
    expect(f.live.adapterRefreshPending).toBe("runtime-new");
    f.gate.resolve();
    await rejection;
    f.assertUnchanged();
    expect(f.live.adapterRefreshPending).toBe("runtime-new");
    expect(f.catalog.prepareSession).toHaveBeenCalledTimes(2);
    expect(f.live.adapterMaintenance).toBe(false);
  });

  it.each([
    { label: "native prompt queued behind maintenance", emitPrompt: true, pendingDialogs: 0 },
    { label: "final resource snapshot", emitPrompt: false, pendingDialogs: 1 },
    { label: "queued native prompt and final snapshot", emitPrompt: true, pendingDialogs: 1 },
  ])(
    "rejects a dialog appearing during restore: $label",
    async ({ emitPrompt, pendingDialogs }) => {
      const f = await reloadRace();
      const reload = f.sup.reloadAdapters("ses_race");
      const rejection = expect(reload).rejects.toThrow(
        "Wait for Pi to finish and answer pending questions before reloading adapters.",
      );
      await f.restoring.promise;
      expect(f.ms.resources).not.toHaveBeenCalled();
      if (emitPrompt) {
        f.ms.emit("bridge", { type: "ui_prompt_start", kind: "custom", title: "Native question" });
        // onBridge is still queued behind restore, but readiness must change synchronously.
        expect(f.live.nativeDialogOpen).toBe(true);
        expect(f.live.terminalPrompt).toBeNull();
        expect(f.sup.pendingInteractions("ses_race")).toEqual([]);
      }
      f.ms.pendingDialogs = pendingDialogs;
      f.gate.resolve();
      await rejection;
      expect(f.ms.resources).toHaveBeenCalledOnce();
      expect(await f.ms.resources.mock.results[0]!.value).toMatchObject({ pendingDialogs });
      f.assertUnchanged();
      await f.live.chain;
      if (emitPrompt) expect(f.live.terminalPrompt).not.toBeNull();
    },
  );
});

describe("session adapter reload", () => {
  it("reloads edited entry without replacing Pi, restores without replay, and fences old actions", async () => {
    h = await startHarness({
      script: [
        {
          when: when.userSays("status"),
          reply: { toolCalls: [{ name: "fixture_status", arguments: {} }] },
        },
        { when: when.toolResult(), reply: { text: "done" } },
      ],
    });
    fixture("one");
    const sup = await start();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: "ses_reload",
      text: "status",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitUntil(
      () =>
        h!.coord
          .eventsOf("session.updated", "ses_reload")
          .some((e) => (e.data as any).settled != null),
      30000,
      "historic tool settled",
    );
    const historic = sup.panels("ses_reload").find((p) => p.slot === "historic");
    expect(historic).toBeDefined();
    (sup as any).setPanel("ses_reload", { ...historic, node: null });
    await waitFor(() => sup.sessionAdapters("ses_reload").reloadable);
    const before = sup.record("ses_reload")!;
    const native = before.nativeHandle;
    const initial = sup.sessionAdapters("ses_reload");
    expect(initial.generation).toBeTruthy();
    expect(sup.panels("ses_reload")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "version", node: { t: "text", text: "one" } }),
      ]),
    );
    await expect(sup.adapterAction("ses_reload", "reload-fixture", "ok", {})).resolves.toEqual({
      ok: true,
    });
    fixture("two");
    const result = await sup.reloadAdapters("ses_reload");
    expect(result.generation).not.toBe(initial.generation);
    expect(sup.record("ses_reload")!.nativeHandle).toEqual(native);
    expect(sup.sessionAdapters("ses_reload").runtimeId).toBe(initial.runtimeId);
    expect(sup.panels("ses_reload")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: "version",
          node: { t: "text", text: "two" },
          adapterGeneration: result.generation,
        }),
      ]),
    );
    expect(sup.panels("ses_reload").some((p) => p.slot === "historic")).toBe(false);
    await expect(
      sup.adapterAction("ses_reload", "reload-fixture", "ok", {}, initial.generation!),
    ).rejects.toThrow(/changed/i);
    await expect(sup.adapterAction("ses_reload", "reload-fixture", "ok", {})).rejects.toThrow(
      /reload/i,
    );
    await expect(
      sup.adapterAction("ses_reload", "reload-fixture", "ok", {}, result.generation),
    ).resolves.toEqual({ ok: true });
    await h.agent.stop();
    const restarted = await h.restartAgent();
    expect(restarted.supervisor.sessionAdapters("ses_reload").generation).toBe(result.generation);
    expect(restarted.supervisor.record("ses_reload")?.requiresAdapterGeneration).toBe(true);
  }, 60000);

  it("keeps an unrepublished actionable panel fenced to its original generation", async () => {
    h = await startHarness();
    fixture("one");
    const entry = join(h.stateDir, "owner-adapters", "reload-fixture", "server.mjs");
    writeFileSync(
      entry,
      `export default {
        onRestore(ctx) { ctx.setPanel('legacy', {t:'actions', actions:[{id:'removed', label:'Old action'}]}); },
        onAction() {},
      };`,
    );
    const sup = await start();
    const oldPanel = sup.panels("ses_reload").find((p) => p.slot === "legacy")!;
    const oldGeneration = sup.sessionAdapters("ses_reload").generation!;
    expect(oldPanel).toMatchObject({
      adapterGeneration: oldGeneration,
      node: { t: "actions", actions: [{ id: "removed", label: "Old action" }] },
    });
    writeFileSync(
      entry,
      `export default {
        onRestore() {},
        onAction() { throw Error('removed action reached the replacement'); },
      };`,
    );
    const result = await sup.reloadAdapters("ses_reload");
    expect(result.generation).not.toBe(oldGeneration);
    expect(sup.sessionAdapters("ses_reload").adapters).toContainEqual(
      expect.objectContaining({ id: "reload-fixture", runtimeStatus: "active" }),
    );
    const retained = sup.panels("ses_reload").find((p) => p.slot === "legacy")!;
    expect(retained).toEqual(oldPanel);
    expect(retained.adapterGeneration).not.toBe(result.generation);
    await expect(
      sup.adapterAction("ses_reload", "reload-fixture", "removed", {}, retained.adapterGeneration),
    ).rejects.toThrow("This extension view changed. Reopen it before trying again.");
  }, 60000);

  it("allows reload after resolving a terminal-only interaction whose state stays unsupported", async () => {
    h = await startHarness({
      script: [
        {
          when: when.userSays("custom"),
          reply: { toolCalls: [{ name: "fixture_custom", arguments: {} }] },
        },
        { when: when.toolResult(), reply: { text: "done" } },
      ],
    });
    fixture("one");
    const sup = await start();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: "ses_reload",
      text: "custom",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    const event = await h.coord.waitEvent(
      (e) => e.type === "interaction.updated" && e.data.state === "unsupported",
      30000,
      "terminal-only interaction",
    );
    if (event.type !== "interaction.updated") throw new Error("Expected interaction.updated");
    await h.coord.waitUntil(
      () =>
        h!.coord
          .eventsOf("session.updated", "ses_reload")
          .some((e) => (e.data as any).settled != null),
      30000,
      "custom tool settled",
    );
    expect(event.data.resolution).toBeNull();
    expect(sup.sessionAdapters("ses_reload").reloadable).toBe(false);
    await expect(sup.reloadAdapters("ses_reload")).rejects.toThrow(/wait/i);
    const answer = await h.coord.ok({
      type: "session.answer",
      sessionId: "ses_reload",
      interactionId: event.data.id,
      revision: event.data.revision,
      response: { kind: "action", actionId: "message" },
      deviceId: "dev_reload",
    });
    expect(answer).toMatchObject({
      status: "answered",
      interaction: { state: "unsupported", resolution: { by: "dev_reload" } },
    });
    expect(sup.sessionAdapters("ses_reload").reloadable).toBe(true);
    const generation = sup.sessionAdapters("ses_reload").generation;
    await expect(sup.reloadAdapters("ses_reload")).resolves.toMatchObject({ ok: true });
    expect(sup.sessionAdapters("ses_reload").generation).not.toBe(generation);
  }, 60000);

  it("blocks reload while an adapter action is active, and retains current context on candidate failure", async () => {
    h = await startHarness();
    fixture("one");
    const sup = await start();
    let release!: () => void;
    (globalThis as any).__adapterGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = sup.adapterAction("ses_reload", "reload-fixture", "wait", {});
    await waitFor(() => !sup.sessionAdapters("ses_reload").reloadable);
    await expect(sup.reloadAdapters("ses_reload")).rejects.toThrow(/wait/i);
    release();
    await action;
    const generation = sup.sessionAdapters("ses_reload").generation;
    const catalog = (sup as any).opts.catalog;
    const spy = vi
      .spyOn(catalog, "prepareSession")
      .mockRejectedValueOnce(new Error("candidate infrastructure failure"));
    await expect(sup.reloadAdapters("ses_reload")).rejects.toThrow(
      "candidate infrastructure failure",
    );
    expect(sup.sessionAdapters("ses_reload").generation).toBe(generation);
    await expect(
      sup.adapterAction("ses_reload", "reload-fixture", "ok", {}, generation!),
    ).resolves.toEqual({ ok: true });
    expect(sup.panels("ses_reload")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: "version", node: { t: "text", text: "one" } }),
      ]),
    );
    spy.mockRestore();
  }, 60000);

  it("rejects a read-only session", async () => {
    h = await startHarness();
    fixture("one");
    const sup = await start("ses_readonly");
    (sup as any).live.get("ses_readonly").rec.readOnly = true;
    expect(sup.sessionAdapters("ses_readonly")).toMatchObject({
      reloadable: false,
      blockedReason: expect.stringMatching(/read.only/i),
    });
    await expect(sup.reloadAdapters("ses_readonly")).rejects.toThrow(/read.only/i);
  }, 60000);

  it("rejects reload while Pi is running a tool", async () => {
    h = await startHarness({
      script: [
        {
          when: when.userSays("slow"),
          reply: { toolCalls: [{ name: "fixture_slow", arguments: { ms: 10000 } }] },
        },
      ],
    });
    fixture("one");
    const sup = await start();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: "ses_reload",
      text: "slow",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await waitFor(() => sup.record("ses_reload")?.runtime === "running", 30000, "running Pi");
    expect(sup.sessionAdapters("ses_reload").reloadable).toBe(false);
    await expect(sup.reloadAdapters("ses_reload")).rejects.toThrow(/wait/i);
    await h.coord.ok({ type: "session.abort", sessionId: "ses_reload", clearQueue: true });
  }, 60000);

  it("rejects reload during a real pending Pi question", async () => {
    h = await startHarness({
      script: [
        {
          when: when.userSays("pick"),
          reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
        },
      ],
    });
    fixture("one");
    const sup = await start();
    await h.coord.ok({
      type: "session.prompt",
      sessionId: "ses_reload",
      text: "pick",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await h.coord.waitUntil(
      () =>
        h!.coord
          .eventsOf("interaction.updated", "ses_reload")
          .some((e) => (e.data as any).state === "pending"),
      30000,
      "pending question",
    );
    expect(sup.sessionAdapters("ses_reload").reloadable).toBe(false);
    await expect(sup.reloadAdapters("ses_reload")).rejects.toThrow(/wait/i);
  }, 60000);
});
