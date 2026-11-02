import type { Interaction } from "@switchyard/protocol";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompatHarness,
  type CompatSession,
  compatSkipReason,
  declaredTool,
  pluginInfo,
  recordResult,
  startCompatHarness,
  toolItem,
  waitFor,
} from "./helpers.js";

const skip = compatSkipReason();

const questions = [
  {
    question: "Which fruit do you want?",
    header: "Fruit",
    options: [
      { label: "Apple", description: "Red and crisp", preview: "```\n  (\\\n  (  )  apple\n```" },
      { label: "Banana", description: "Yellow", preview: "```\n  )  banana\n```" },
    ],
  },
  {
    question: "Which toppings do you want?",
    header: "Toppings",
    multiSelect: true,
    options: [
      { label: "A", description: "Topping A" },
      { label: "B", description: "Topping B" },
      { label: "C", description: "Topping C" },
    ],
  },
];

const script: MockScript = [
  {
    when: when.userSays("ask me"),
    reply: { toolCalls: [{ name: "ask_user_question", arguments: { questions } }] },
  },
  { when: when.toolResult("ask_user_question"), reply: { text: "thanks" } },
];

async function askAndClaim(s: CompatSession): Promise<Interaction> {
  await s.prompt("please ask me some questions");
  await waitFor(
    () => s.latestInteractions().some((i) => i.state === "pending"),
    30000,
    "pending interaction",
  );
  return s.latestInteractions().find((i) => i.state === "pending")!;
}

describe.skipIf(skip !== null)(`ask-user-question compat${skip ? ` (${skip})` : ""}`, () => {
  let h: CompatHarness;
  const results: Record<string, unknown> = {};
  beforeAll(async () => {
    h = await startCompatHarness({ plugins: ["pi-ask-user-question"], script });
  });
  afterAll(async () => {
    recordResult("ask-user-question", {
      plugin: pluginInfo(["pi-ask-user-question"]),
      tool: declaredTool(h.mock, "ask_user_question")?.name ?? null,
      ...results,
    });
    await h?.dispose();
  });

  it("claims the first dialog and answers the whole sequence from one form", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    const pending = await askAndClaim(s);
    results.formRequests = structuredClone(s.uiRequests);
    expect(pending.adapterId).toBe("ask-user-question");
    expect(pending.presentation).toMatchObject({
      t: "form",
      fields: [
        {
          name: "q1",
          kind: "select",
          options: [
            { value: "Apple", preview: questions[0]!.options[0]!.preview },
            { value: "Banana" },
          ],
        },
        {
          name: "q2",
          kind: "multiselect",
          options: [{ value: "A" }, { value: "B" }, { value: "C" }],
        },
      ],
    });

    const r = await s.answer(pending, { kind: "form", values: { q1: "Apple", q2: ["A", "C"] } });
    expect(r.status).toBe("answered");
    await s.waitSettled(before);
    results.formAllRequests = structuredClone(s.uiRequests);
    results.formResponses = structuredClone(s.uiResponses);

    const end = s.toolEnds("ask_user_question").at(-1);
    results.formToolEnd = end;
    expect(end?.isError).toBe(false);
    expect(end?.result?.details?.cancelled).toBe(false);
    expect(end?.result?.details?.answers).toMatchObject([
      { header: "Fruit", kind: "option", answer: "Apple" },
      { header: "Toppings", kind: "multi", selected: ["A", "C"] },
    ]);

    // The user answered one form; the plugin's numbered multi-select input ("1,3") was produced by
    // the adapter and answered by the host, never typed by the user.
    const shown = s.latestInteractions();
    expect(shown[0]).toMatchObject({
      id: pending.id,
      state: "resolved",
      resolution: { by: "dev_compat" },
    });
    for (const i of shown.slice(1)) {
      expect(i).toMatchObject({
        state: "resolved",
        resolution: { by: "host", summary: "Answered from your earlier form" },
      });
    }
    const multi = s.uiRequests.find(
      (r) => r.method === "input" && r.title.startsWith("[Toppings]"),
    );
    expect(multi?.title).toContain("comma-separated");
    expect(s.uiResponses.find((r) => r.id === multi?.id)?.body).toEqual({ value: "1,3" });
    expect(toolItem(s, "ask_user_question")?.data.status).toBe("ok");
  });

  it("maps an Other answer to the plugin's Type something. option and its input", async () => {
    const s = await h.startSession();
    const before = s.settledCount();
    const pending = await askAndClaim(s);
    expect(pending.adapterId).toBe("ask-user-question");
    const r = await s.answer(pending, {
      kind: "form",
      values: { q1: { other: "Durian" }, q2: ["B"] },
    });
    expect(r.status).toBe("answered");
    await s.waitSettled(before);
    results.otherRequests = structuredClone(s.uiRequests);
    results.otherResponses = structuredClone(s.uiResponses);
    const end = s.toolEnds("ask_user_question").at(-1);
    results.otherToolEnd = end;
    expect(end?.isError).toBe(false);
    expect(end?.result?.details?.answers).toMatchObject([
      { header: "Fruit", answer: "Durian" },
      { header: "Toppings", kind: "multi", selected: ["B"] },
    ]);
    const typed = s.uiRequests.find(
      (r) => r.method === "input" && /Type your answer/.test(r.title),
    );
    expect(typed).toBeTruthy();
    expect(s.uiResponses.find((x) => x.id === typed.id)?.body).toEqual({ value: "Durian" });
    for (const i of s.latestInteractions().slice(1)) {
      expect(i.resolution?.by).toBe("host");
    }
  });
});
