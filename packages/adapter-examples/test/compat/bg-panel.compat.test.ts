import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  compatSkipReason,
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

describe.skipIf(skip !== null)(`bg panel compat${skip ? ` (${skip})` : ""}`, () => {
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

  it("bg_run updates the bg panel while the job runs and after it ends", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    await s.prompt("please start the job");
    await s.waitSettled(before);
    const end = s.toolEnds("bg_run").at(-1);
    results.toolEnd = end;
    expect(end?.isError).toBe(false);

    expect(end?.result?.details?.id).toEqual(expect.any(String));

    const bgPanel = () => s.panels().find((p) => p.adapterId === "bg" && p.slot === "bg");
    const updates = () =>
      h.coord
        .eventsOf("panel.updated", s.id)
        .map((e) => e.data as any)
        .filter((p) => p.adapterId === "bg" && p.slot === "bg");
    // While the job runs: "bg: compat 0:01" style elapsed time.
    await waitFor(() => updates().length > 0, 10000, "bg panel");
    const running = updates()[0];
    results.runningPanel = running;
    expect(running).toMatchObject({
      title: "Background",
      webRenderer: true,
      node: { t: "text", text: expect.stringMatching(/^bg: compat \d+:\d\d$/) },
      state: { status: expect.stringMatching(/^bg: compat /), lines: [] },
    });
    // After it exits the plugin marks it done.
    await waitFor(
      () => /\u2713/.test(bgPanel()?.mobileFallback ?? ""),
      15000,
      "bg panel shows the finished job",
    );
    results.uiRequests = s.uiRequests.filter(
      (r) => r.method === "setStatus" || r.method === "setWidget",
    );
    results.finalPanel = bgPanel();
    results.panelUpdates = updates();
    expect(bgPanel()).toMatchObject({
      node: { t: "text", text: "bg: compat \u2713" },
      state: { status: "bg: compat \u2713" },
    });
    expect(updates().length).toBeGreaterThanOrEqual(2);
  });
});
