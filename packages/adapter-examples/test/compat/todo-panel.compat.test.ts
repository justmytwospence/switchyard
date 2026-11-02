import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  compatSkipReason,
  declaredTool,
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

describe.skipIf(skip !== null)(`todo panel compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, any> = {};
  beforeAll(async () => {
    h = await startCompatHarness({ plugins: ["pi-todo"], script });
  });
  afterAll(async () => {
    recordResult("todo-panel", { plugin: pluginInfo(["pi-todo"]), ...results });
    await h?.dispose();
  });

  it("todo tool results update the todo panel", async () => {
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

    const panel = s.panels().find((p) => p.adapterId === "todo" && p.slot === "todo");
    results.panel = panel;
    expect(panel).toBeTruthy();
    expect(panel!.title).toBe("Todo");
    expect(panel!.node).toMatchObject({
      t: "list",
      items: [
        { t: "text", text: "[~] Write the compat tests" },
        { t: "text", text: "[ ] Update the docs" },
      ],
    });
    expect(panel!.mobileFallback).toBe("[~] Write the compat tests\n[ ] Update the docs");
    // The panel was published after each call (three panel updates for the todo slot).
    const updates = h.coord
      .eventsOf("panel.updated", s.id)
      .filter((e) => (e.data as any).adapterId === "todo");
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });
});
