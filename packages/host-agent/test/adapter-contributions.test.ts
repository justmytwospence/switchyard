// @module-tag slow
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ManagedSession } from "@switchyard/pi-runtime";
import type { Panel } from "@switchyard/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type HostHarness, mockProfile, seedSession, startHarness, tempDir } from "./helpers.js";

/** Exercise the persistence boundary without launching Pi or modifying the real adapter directory. */
describe("host adapter contributions", () => {
  let h: HostHarness;
  const workspace = tempDir();
  const id = "ses_contributions";
  const panel = (
    adapterId: string,
    slot: string,
    contribution?: Panel["contribution"],
  ): Omit<Panel, "sessionId" | "updatedAt"> => ({
    adapterId,
    slot,
    title: "Restored",
    node: { t: "text", text: "portable" },
    mobileFallback: "portable",
    webRenderer: false,
    ...(contribution ? { contribution, state: { n: 1 } } : {}),
  });
  beforeAll(async () => {
    h = await startHarness({ withPi: false });
    seedSession(h, id, { cwd: workspace.path });
    // This persistence fixture has no Pi process. Supply explicit live trust/resource evidence
    // rather than relying on the old cwd-only catalog API to authorize project code.
    vi.spyOn(h.agent.supervisor as any, "adapterResources").mockResolvedValue({
      resources: { status: "available", extensions: [], diagnostics: [] },
      projectTrusted: true,
      reportedExtensionPaths: [],
      extensionsDisabled: false,
    });
  });
  afterEach(() => {
    const supervisor = h.agent.supervisor as any;
    supervisor.live.get(id)?.adapters?.close();
    supervisor.live.delete(id);
    supervisor.opts.catalog.releaseSession(id);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.dispose();
    workspace.cleanup();
  });
  const liveSession = (cwd: string) => {
    const supervisor = h.agent.supervisor as any;
    const live = {
      rec: { ...supervisor.getRecord(id), cwd },
      // This persistence-only fixture supplies a ready runtime; no Pi process is launched.
      ms: { isAlive: true, bridgeFeatures: null },
      registry: null,
      adapters: null,
      adapterActionCount: 0,
      adapterMaintenance: false,
    };
    supervisor.live.set(id, live);
    return live;
  };

  it("round-trips metadata/state and tombstones only missing adapters on opening", async () => {
    const dir = join(workspace.path, ".switchyard", "adapters", "present");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "switchyard-adapter.json"),
      JSON.stringify({
        id: "present",
        version: "1.0.0",
        target: { extension: "fixture", versionRange: "*", testedVersions: [] },
        protocolVersion: 1,
        server: "server.mjs",
        webRenderer: null,
        capabilities: ["panels"],
      }),
    );
    writeFileSync(
      join(dir, "server.mjs"),
      "export default { onAction(id) { if (id === 'fail') throw Error('failed'); } };\n",
    );
    const supervisor = h.agent.supervisor as any;
    for (const [adapter, slot, descriptor] of [
      ["present", "@slot/keep", { id: "keep", placement: "session.panel" }],
      ["missing", "@slot/gone", { id: "gone", placement: "sidebar.header" }],
      ["missing", "legacy", undefined],
    ] as const)
      supervisor.setPanel(id, panel(adapter, slot, descriptor));
    expect(supervisor.panels(id)).toContainEqual(
      expect.objectContaining({
        adapterId: "present",
        state: { n: 1 },
        contribution: { id: "keep", placement: "session.panel" },
      }),
    );
    const live = liveSession(workspace.path);
    await supervisor.openAdapters(live, workspace.path);
    expect(live.adapters).toBeTruthy();
    expect(supervisor.panels(id).map((p: Panel) => [p.adapterId, p.slot])).toEqual(
      expect.arrayContaining([["present", "@slot/keep"]]),
    );
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "@slot/gone")).toBe(false);
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "legacy")).toBe(false);
    await h.coord.waitUntil(() =>
      h.coord
        .eventsOf("panel.updated", id)
        .some(
          (e) =>
            e.data.adapterId === "missing" && e.data.slot === "@slot/gone" && e.data.node === null,
        ),
    );
    const tombstone = h.coord
      .eventsOf("panel.updated", id)
      .find(
        (e) =>
          e.data.adapterId === "missing" && e.data.slot === "@slot/gone" && e.data.node === null,
      );
    expect(tombstone?.data).toMatchObject({ contribution: { id: "gone" }, state: { n: 1 } });
    supervisor.live.set(id, live);
    expect(await supervisor.adapterAction(id, "present", "run", {})).toEqual({ ok: true });
    await expect(supervisor.adapterAction(id, "missing", "run", {})).rejects.toThrow(
      "unknown adapter missing",
    );
    await expect(supervisor.adapterAction(id, "present", "fail", {})).rejects.toThrow(
      "onAction failed: failed",
    );
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "@slot/keep")).toBe(false);
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "legacy")).toBe(false);
    rmSync(dir, { recursive: true });
    await supervisor.openAdapters(live, workspace.path);
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "@slot/keep")).toBe(false);
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "legacy")).toBe(false);
  });

  it("emits authoritative renderer content changes and removals without metadata changes", async () => {
    const root = tempDir();
    try {
      const dir = join(root.path, ".switchyard", "adapters", "renderer");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "switchyard-adapter.json"),
        JSON.stringify({
          id: "renderer",
          version: "1.0.0",
          protocolVersion: 1,
          target: { extension: "fixture", versionRange: "*", testedVersions: [] },
          server: "server.mjs",
          webRenderer: "renderer.html",
          capabilities: ["panels"],
        }),
      );
      writeFileSync(join(dir, "server.mjs"), "export default {};\n");
      const file = join(dir, "renderer.html");
      writeFileSync(file, "first");
      const supervisor = h.agent.supervisor as any;
      const live = liveSession(root.path);
      const updates = () =>
        h.coord
          .eventsOf("adapters.updated")
          .filter((e) => e.data.renderers?.renderer !== undefined);
      await supervisor.openAdapters(live, root.path);
      await h.coord.waitUntil(() => updates().some((e) => e.data.renderers.renderer === "first"));
      const before = updates().length;
      writeFileSync(file, "second");
      await supervisor.openAdapters(live, root.path);
      await h.coord.waitUntil(() => updates().length > before);
      expect(updates().at(-1)?.data.renderers.renderer).toBe("second");
      rmSync(dir, { recursive: true });
      const count = h.coord.eventsOf("adapters.updated").length;
      await supervisor.openAdapters(live, root.path);
      await h.coord.waitUntil(() => h.coord.eventsOf("adapters.updated").length > count);
      expect(h.coord.eventsOf("adapters.updated").at(-1)?.data.renderers?.renderer).toBeUndefined();
      expect(h.coord.eventsOf("adapters.updated").at(-1)?.data.renderers).not.toHaveProperty(
        "renderer",
      );
    } finally {
      root.cleanup();
    }
  });

  it("publishes renderer-backed tombstones with webRenderer false while preserving new legacy frames", async () => {
    const supervisor = h.agent.supervisor as any;
    supervisor.setPanel(id, { ...panel("present", "renderer"), webRenderer: true });
    supervisor.setPanel(id, { ...panel("present", "renderer"), node: null, webRenderer: true });
    await h.coord.waitUntil(() =>
      h.coord
        .eventsOf("panel.updated", id)
        .some((e) => e.data.slot === "renderer" && e.data.node === null),
    );
    expect(
      h.coord
        .eventsOf("panel.updated", id)
        .find((e) => e.data.slot === "renderer" && e.data.node === null)?.data.webRenderer,
    ).toBe(false);
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "renderer")).toBe(false);
    supervisor.setPanel(id, { ...panel("present", "legacy-frame"), node: null, webRenderer: true });
    expect(supervisor.panels(id).find((p: Panel) => p.slot === "legacy-frame")?.webRenderer).toBe(
      true,
    );
    supervisor.setPanel(id, { ...panel("present", "legacy-frame"), node: null, webRenderer: true });
    expect(supervisor.panels(id).some((p: Panel) => p.slot === "legacy-frame")).toBe(false);
  });

  it("patches the original notice only while its runtime and transcript generation are current", async () => {
    const supervisor = h.agent.supervisor as any;
    const ms = new ManagedSession({
      sessionId: id,
      cwd: workspace.path,
      title: "Test",
      profile: mockProfile,
    });
    const notices: any[] = [];
    ms.on("item", (item) => notices.push(item));
    (ms as any).onMessageEnd({ role: "custom", customType: "example", content: [] });
    const item = notices[0];
    let resolve!: (value: { adapterId: string; node: { t: "text"; text: string } }) => void;
    const live = {
      rec: { adapterGeneration: undefined },
      ms,
      adapters: {
        customMessageCard: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    };
    const message = { customType: "example", content: [] };
    const pending = supervisor.applyCustomMessageCard(live, ms, item.id, message);
    resolve({ adapterId: "present", node: { t: "text", text: "rendered" } });
    await pending;
    expect(notices.at(-1)).toMatchObject({
      id: item.id,
      order: item.order,
      data: {
        text: "Custom message: example",
        card: { t: "text", text: "rendered" },
        adapterId: "present",
      },
    });
    const before = notices.length;
    const replaced = supervisor.applyCustomMessageCard(live, ms, item.id, message);
    live.ms = new ManagedSession({
      sessionId: id,
      cwd: workspace.path,
      title: "New",
      profile: mockProfile,
    });
    resolve({ adapterId: "present", node: { t: "text", text: "stale" } });
    await replaced;
    expect(notices).toHaveLength(before);
    live.ms = ms;
    const rewound = supervisor.applyCustomMessageCard(live, ms, item.id, message);
    supervisor.cardGenerations.set(ms, 1);
    resolve({ adapterId: "present", node: { t: "text", text: "rewound" } });
    await rewound;
    expect(notices).toHaveLength(before);
    const generation = supervisor.getRecord(id).adapterGeneration;
    await expect(supervisor.adapterAction(id, "present", "run", {}, generation)).rejects.toThrow(
      "Session is not running",
    );
  });
});
