import { type AdapterEffect, AdapterRegistry } from "@switchyard/adapter-sdk";
import type { AdapterContext, AdapterContribution } from "@switchyard/adapter-sdk/contract";
import { describe, expect, it } from "vitest";
import { exampleAdapters } from "../src/index.js";
import tasks, { supports, TASKS_TOOL } from "../src/tasks/server.js";

const items = [
  { text: "Read the spec", state: "done" },
  { text: "Write the adapter", state: "doing" },
  { text: "Ship", state: "todo" },
];
const call = { toolCallId: "c1", name: TASKS_TOOL, args: { action: "set", items } };

function v2() {
  const effects: AdapterEffect[] = [];
  const registry = new AdapterRegistry();
  registry.setAdapters(exampleAdapters().filter((a) => a.manifest.id === "tasks"));
  const session = registry.openSession({ sessionId: "ses_tasks", emit: (e) => effects.push(e) });
  const panels = () =>
    effects.filter((e): e is Extract<AdapterEffect, { type: "panel" }> => e.type === "panel");
  return { session, panels };
}

/** A host from before contract v2: no `features`, and the v2 placements do not validate. */
function v1Context() {
  const placed = new Map<string, AdapterContribution | null>();
  const values = new Map<string, unknown>();
  const ctx: AdapterContext = {
    sessionId: "ses_old",
    adapterId: "tasks",
    state: {
      get: <T>(k: string) => values.get(k) as T | undefined,
      set: (k, v) => void values.set(k, v),
      delete: (k) => void values.delete(k),
      keys: () => [...values.keys()],
    },
    setPanel() {},
    setContribution(id, c) {
      if (c && ["composer.tracker", "session.badge"].includes(c.placement)) {
        throw new Error(`Invalid option: ${c.placement}`);
      }
      const walk = (n: { t: string }) => {
        if (["checklist", "facts", "rows", "badge"].includes(n.t))
          throw new Error(`Invalid node ${n.t}`);
      };
      if (c) walk(c.node);
      placed.set(id, c);
    },
    attention() {},
    linkSubagent() {},
    queueAnswers() {},
    log() {},
  };
  return { ctx, placed };
}

describe("tasks example (contract v2)", () => {
  it("publishes a tracker with a checklist and a badge, and describes its tool row", async () => {
    const { session, panels } = v2();
    await session.onToolStart(call);
    await session.onToolEnd({ ...call, result: {}, isError: false });
    const tracker = panels().find((p) => p.contribution?.placement === "composer.tracker");
    expect(tracker).toMatchObject({
      title: "Tasks",
      node: { t: "checklist" },
      contribution: { tracker: { count: "1/3", status: "running", step: "Write the adapter" } },
    });
    expect(panels().find((p) => p.contribution?.placement === "session.badge")?.node).toEqual({
      t: "badge",
      text: "Tasks 1/3",
    });
    expect(await session.toolView({ ...call, result: {} })).toMatchObject({
      view: { verb: "Updated tasks", meta: ["1/3"], detail: { t: "checklist" } },
    });
    expect(await session.toolView({ toolCallId: "c2", name: "ask_owner", args: {} })).toMatchObject(
      {
        view: { hide: true },
      },
    );
    expect(session.statuses()[0]).toMatchObject({ status: "active" });
  });

  it("says its dialog is a question", async () => {
    const { session } = v2();
    const r = await session.onUiRequest({
      id: "r1",
      method: "select",
      title: "Owner question: Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(r).toMatchObject({
      kind: "claim",
      adapterId: "tasks",
      claim: { title: "Which database?", kind: "question" },
    });
  });

  it("falls back to a pill and a plain list on a host from before v2", async () => {
    const { ctx, placed } = v1Context();
    expect(supports(ctx, "adapter.trackers.v1")).toBe(false);
    await tasks.onToolEnd?.({ ...call, result: {}, isError: false }, ctx);
    expect([...placed.keys()]).toEqual(["tasks"]);
    expect(placed.get("tasks")).toMatchObject({
      placement: "composer.pill",
      node: { t: "text", text: "Tasks 1/3" },
    });
    // A v1 host never calls toolView; if it did, the detail would still be a v1 node.
    expect(await tasks.toolView?.(call, ctx)).toMatchObject({ detail: { t: "list" } });
  });
});
