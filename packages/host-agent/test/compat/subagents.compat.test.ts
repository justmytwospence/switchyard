import { existsSync } from "node:fs";
import type { TranscriptItem } from "@switchyard/protocol";
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
const CHILD_TASK = "Reply with the single word pong";

const script: MockScript = [
  // The child Pi inherits PI_CODING_AGENT_DIR, so its model requests reach this mock too.
  { when: when.userSays(CHILD_TASK), reply: { text: "pong" } },
  {
    when: when.userSays("please delegate"),
    reply: {
      toolCalls: [
        {
          name: "subagent",
          arguments: {
            task: CHILD_TASK,
            label: "pong check",
            // Explicit choices, so the plugin does not ask a network classifier to pick them.
            agent: "general",
            model: "mock/mock-1",
            thinking: "off",
          },
        },
      ],
    },
  },
  { when: when.toolResult("subagent"), reply: (r) => ({ text: `subagent said: ${r.lastText}` }) },
];

describe.skipIf(skip !== null)(`subagents compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, any> = {};
  beforeAll(async () => {
    h = await startCompatHarness({ plugins: ["pi-subagents"], script });
  });
  afterAll(async () => {
    recordResult("subagents", { plugin: pluginInfo(["pi-subagents"]), ...results });
    await h?.dispose();
  });

  it("a subagent run produces a subagent transcript item with its session file", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    await s.prompt("please delegate this");
    try {
      await s.waitSettled(before, 90000);
    } finally {
      results.toolEnds = s.toolEnds("subagent");
      results.entries = s.piEvents
        .filter((e) => e.type === "entry_appended" && e.entry?.type === "custom")
        .map((e) => e.entry);
      results.childRequests = h.mock.requests
        .filter((r) => r.lastText.includes(CHILD_TASK))
        .map((r) => ({ lastText: r.lastText, tools: r.tools }));
      results.stderr = h.agent.supervisor.managedSession(s.id)?.process?.stderr;
    }
    const end = s.toolEnds("subagent").at(-1);
    expect(end?.isError).toBe(false);
    // No network classifier was consulted (it would leave a system1:decision entry or a
    // `classifier` record on the run).
    expect(results.entries.some((e: any) => e.customType === "system1:decision")).toBe(false);
    expect(end?.result?.details?.runs?.[0]?.classifier).toBeUndefined();
    expect(results.childRequests.length).toBeGreaterThan(0);

    const subagentItems = () =>
      s
        .latestItems()
        .filter((i): i is Extract<TranscriptItem, { kind: "subagent" }> => i.kind === "subagent");
    await waitFor(
      () => subagentItems().some((i) => i.data.sessionFile),
      10000,
      "subagent item with sessionFile",
    );
    const item = subagentItems().find((i) => i.data.sessionFile)!;
    results.subagentItem = item;
    expect(item.data).toMatchObject({
      runId: expect.any(String),
      label: expect.any(String),
      linkedSessionId: null,
    });
    // Linked by the adapter pi-subagents ships, loaded through the plugin tier.
    expect(h.adapter("subagents")).toMatchObject({ tier: "plugin" });
    expect(item.data.sessionFile).toMatch(/\.jsonl$/);
    expect(existsSync(item.data.sessionFile!)).toBe(true);
    expect(["done", "running"]).toContain(item.data.status);
  });
});
