// @module-tag slow
import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  compatSkipReason,
  legacyBoundAdapter,
  pluginInfo,
  recordResult,
  startCompatHarness,
  waitFor,
} from "./helpers.js";

const skip = compatSkipReason();

const script: MockScript = [
  {
    when: when.userSays("start the job"),
    reply: {
      toolCalls: [
        {
          name: "bg_run",
          arguments: { command: "sleep 2; echo compat-done", kind: "job", name: "compat" },
        },
      ],
    },
  },
  { when: when.toolResult("bg_run"), reply: { text: "started" } },
  { when: when.always(), reply: { text: "noted" } },
];

describe.skipIf(skip !== null)(`bg tracker compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, any> = {};
  beforeAll(async () => {
    // The harness gives Pi an empty HOME: pi-bg writes job logs under ~/.pi/agent/bg (it ignores PI_CODING_AGENT_DIR).
    h = await startCompatHarness({ plugins: ["pi-bg"], script });
  });
  afterAll(async () => {
    recordResult("bg-panel", { plugin: pluginInfo(["pi-bg"]), ...results });
    await h?.dispose();
  });

  it("bg_run updates the Background tracker while the job runs and after it ends", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    await s.prompt("please start the job");
    await s.waitSettled(before);
    const end = s.toolEnds("bg_run").at(-1);
    results.toolEnd = end;
    expect(end?.isError).toBe(false);

    expect(end?.result?.details?.id).toEqual(expect.any(String));
    if (await legacyBoundAdapter(h, s, "pi-bg", "bg")) {
      expect(s.panels().filter((p) => p.adapterId === "bg")).toEqual([]);
      return;
    }

    // On a contract v2 host the adapter publishes a tracker with one row per task, built from
    // the entries pi-bg writes, instead of a panel that parses the status text.
    const isTracker = (p: any) =>
      p.adapterId === "bg" && p.node && p.contribution?.id === "bg-tracker";
    const bgTracker = () => s.panels().find(isTracker) as any;
    const updates = () =>
      h.coord
        .eventsOf("panel.updated", s.id)
        .map((e) => e.data as any)
        .filter(isTracker);
    // The coordinator's events carry what this harness negotiated (a pill for a v1 coordinator);
    // the host's own panel is the v2 shape.
    await waitFor(() => updates().length > 0 && !!bgTracker(), 10000, "bg tracker");
    const running = bgTracker();
    results.runningTracker = running;
    // Published by the adapter pi-bg ships, loaded through the plugin tier (with its renderer).
    expect(h.adapter("bg")).toMatchObject({ tier: "plugin", webRenderer: true });
    expect(running, JSON.stringify(s.panels())).toMatchObject({
      title: "Background",
      contribution: {
        placement: "composer.tracker",
        tracker: { count: "1 running", status: "running", step: "compat" },
      },
      node: {
        t: "rows",
        rows: [{ title: "compat", status: "running", meta: expect.stringMatching(/^for \d+s$/) }],
      },
    });
    // After it exits the plugin marks it done.
    await waitFor(
      () => bgTracker()?.node?.rows?.[0]?.status === "done",
      15000,
      "bg tracker shows the finished job",
    );
    results.uiRequests = s.uiRequests.filter(
      (r) => r.method === "setStatus" || r.method === "setWidget",
    );
    results.finalTracker = bgTracker();
    results.trackerUpdates = updates();
    expect(bgTracker()).toMatchObject({
      contribution: { tracker: { status: "ok" } },
      node: {
        t: "rows",
        rows: [
          {
            title: "compat",
            status: "done",
            tone: "success",
            meta: expect.stringMatching(/^after \d+s$/),
          },
        ],
      },
    });
    expect(bgTracker().contribution.tracker.count).toBeUndefined();
    // The tracker replaces the old panel; it is not shown beside it.
    expect(
      s
        .panels()
        .filter((p) => p.adapterId === "bg" && p.contribution?.placement === "session.panel"),
    ).toEqual([]);
    expect(updates().length).toBeGreaterThanOrEqual(2);
  });
});
