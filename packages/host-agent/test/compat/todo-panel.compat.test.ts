// @module-tag slow
// @module-tag compat
import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  compatSkipReason,
  declaredTool,
  legacyBoundAdapter,
  pluginInfo,
  recordResult,
  startCompatHarness,
} from "./helpers.js";

const skip = compatSkipReason();

const todo = (args: Record<string, unknown>) => ({
  toolCalls: [{ name: "todo", arguments: args }],
});
let step = 0;
const steps = [
  todo({ action: "create", subject: "Write the compat tests" }),
  todo({ action: "create", subject: "Update the docs" }),
  todo({ action: "update", id: 1, status: "in_progress", activeForm: "writing compat tests" }),
];

const script: MockScript = [
  {
    when: when.userSays("plan the work"),
    reply: () => {
      step = 0;
      return steps[0]!;
    },
  },
  {
    when: when.toolResult("todo"),
    reply: () => (++step < steps.length ? steps[step]! : { text: "planned" }),
  },
];

describe.skipIf(skip !== null)(`todo tracker compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, any> = {};
  beforeAll(async () => {
    h = await startCompatHarness({ plugins: ["pi-todo"], script });
  });
  afterAll(async () => {
    recordResult("todo-panel", { plugin: pluginInfo(["pi-todo"]), ...results });
    await h?.dispose();
  });

  it("todo tool results update the Todo tracker and badge", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    await s.prompt("please plan the work");
    await s.waitSettled(before);

    const schema = declaredTool(h.mock, "todo")?.parameters;
    results.schemaActions = schema?.properties?.action?.enum;
    expect(schema?.properties?.action?.enum).toEqual(expect.arrayContaining(["create", "update"]));
    const ends = s.toolEnds("todo");
    results.toolEnds = ends;
    expect(ends).toHaveLength(3);
    for (const e of ends) expect(e.isError).toBe(false);
    if (await legacyBoundAdapter(h, s, "pi-todo", "todo")) {
      expect(JSON.stringify(ends)).toContain("Write the compat tests");
      expect(s.panels().filter((p) => p.adapterId === "todo")).toEqual([]);
      return;
    }

    // On a contract v2 host the adapter publishes a tracker and a badge instead of a panel.
    const mine = () => s.panels().filter((p) => p.adapterId === "todo" && p.node);
    const tracker = mine().find((p) => p.contribution?.id === "todo-tracker");
    results.tracker = tracker;
    expect(
      tracker,
      JSON.stringify({ panels: s.panels(), adapters: h.agent.supervisor.sessionAdapters(s.id) }),
    ).toBeTruthy();
    // Published by the adapter pi-todo ships, loaded through the plugin tier.
    expect(h.adapter("todo")).toMatchObject({ tier: "plugin" });
    expect(tracker).toMatchObject({
      title: "Todo",
      contribution: {
        placement: "composer.tracker",
        tracker: { count: "0/2", status: "running", step: "writing compat tests" },
      },
      node: {
        t: "checklist",
        items: [
          { text: "Write the compat tests", state: "doing" },
          { text: "Update the docs", state: "todo" },
        ],
      },
      mobileFallback: "[~] Write the compat tests\n[ ] Update the docs",
    });
    const badge = mine().find((p) => p.contribution?.id === "todo-badge");
    results.badge = badge;
    expect(badge).toMatchObject({
      contribution: { placement: "session.badge" },
      node: { t: "badge", text: "Todo 0/2" },
    });
    // The tracker replaces the old panel and pill; they are not shown beside it.
    expect(
      mine().filter(
        (p) =>
          p.contribution?.placement === "session.panel" ||
          p.contribution?.placement === "composer.pill",
      ),
    ).toEqual([]);
    // The tracker was published after each call (three updates of its slot).
    const updates = h.coord
      .eventsOf("panel.updated", s.id)
      .map((e) => e.data as any)
      .filter((p) => p.adapterId === "todo" && p.contribution?.id === "todo-tracker");
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });
});
