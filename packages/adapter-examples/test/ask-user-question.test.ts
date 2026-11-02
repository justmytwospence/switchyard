import type { AdapterSession, PiUiRequest, PiUiResponse } from "@switchyard/adapter-sdk";
import { type InteractionResponse, validateUINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  fruitOtherInput,
  fruitQuestion,
  fruitSelect,
  harness,
  sizeQuestion,
  sizeSelect,
  toppingsInput,
  toppingsQuestion,
} from "./fixtures.js";

const CALL = "call-ask-1";

async function start(session: AdapterSession, questions: unknown[]) {
  await session.onToolStart({ toolCallId: CALL, name: "ask_user_question", args: { questions } });
}

/** Play Pi's dialog sequence: answer the first claim with `answer`, everything else must be queued. */
async function play(session: AdapterSession, dialogs: PiUiRequest[], answer: InteractionResponse) {
  const sent: PiUiResponse[] = [];
  const [first, ...rest] = dialogs;
  const claimed = await session.onUiRequest(first!);
  expect(claimed).toMatchObject({ kind: "claim", adapterId: "ask-user-question" });
  if (claimed.kind !== "claim") throw new Error("unreachable");
  const out = await session.respond(claimed, answer);
  if (out.kind !== "respond") throw new Error(`reclaimed: ${out.reason}`);
  sent.push(out.response);
  for (const d of rest) {
    const q = await session.onUiRequest(d);
    expect(q, `dialog ${d.id} should be answered from the form`).toMatchObject({
      kind: "queued",
      toolCallId: CALL,
    });
    if (q.kind === "queued") sent.push(q.response);
  }
  return { claimed, sent };
}

describe("ask-user-question adapter", () => {
  it("claims the first dialog and presents every question in one form", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const out = await session.onUiRequest(fruitSelect);
    if (out.kind !== "claim") throw new Error("expected claim");
    expect(out.adapterId).toBe("ask-user-question");
    expect(out.claim.ownerToolCallId).toBe(CALL);
    const form = validateUINode(out.claim.presentation);
    expect(form).toMatchObject({
      t: "form",
      fields: [
        {
          kind: "select",
          name: "q1",
          label: "Which fruit should we use?",
          allowOther: { label: "Type something." },
          options: [
            {
              value: "Apple",
              label: "Apple",
              description: "Red and crunchy",
              preview: "An apple a day",
            },
            { value: "Banana" },
            { value: "Cherry" },
          ],
        },
        {
          kind: "multiselect",
          name: "q2",
          options: [{ value: "Cream", preview: "```\ncream\n```" }, {}, {}],
        },
      ],
    });
  });

  it("single select -> the numbered option string", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion]);
    const { sent } = await play(session, [fruitSelect], { kind: "form", values: { q1: "Banana" } });
    expect(sent).toEqual([{ value: "2. Banana - Yellow and soft" }]);
    expect(session.queuedAnswers()).toEqual({});
  });

  it("single + multi select -> option string, then '1,3' for the multi-select input", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const { sent } = await play(session, [fruitSelect, toppingsInput], {
      kind: "form",
      values: { q1: "Apple", q2: ["Syrup", "Cream"] },
    });
    expect(sent).toEqual([{ value: "1. Apple - Red and crunchy" }, { value: "1,3" }]);
  });

  it("Other -> 'Type something.' then the typed answer in the follow-up input", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const { sent } = await play(session, [fruitSelect, fruitOtherInput, toppingsInput], {
      kind: "form",
      values: { q1: { other: "Durian" }, q2: ["Nuts"] },
    });
    expect(sent).toEqual([{ value: "4. Type something." }, { value: "Durian" }, { value: "2" }]);
  });

  it("skips questions whose showIf is unmet (no dialog, no queued answer)", async () => {
    const { session } = harness();
    const conditional = { ...toppingsQuestion, showIf: { header: "Fruit", answers: ["Banana"] } };
    await start(session, [fruitQuestion, conditional, sizeQuestion]);
    const first = await session.onUiRequest(fruitSelect);
    if (first.kind !== "claim") throw new Error("expected claim");
    expect(first.claim.presentation).toMatchObject({
      fields: [{}, { name: "q2", showIf: { field: "q1", values: ["Banana"] } }, {}],
    });
    const out = await session.respond(first, {
      kind: "form",
      values: { q1: "Apple", q3: "Large" },
    });
    expect(out).toEqual({
      kind: "respond",
      response: { value: "1. Apple - Red and crunchy" },
      queued: 1,
    });
    // Pi skips the toppings dialog and asks the size next.
    expect(await session.onUiRequest(sizeSelect)).toMatchObject({
      kind: "queued",
      response: { value: "2. Large" },
    });
    expect(session.queuedAnswers()).toEqual({});
  });

  it("asks the conditional question when its condition is met", async () => {
    const { session } = harness();
    const conditional = { ...toppingsQuestion, showIf: { header: "Fruit", answers: ["Banana"] } };
    await start(session, [fruitQuestion, conditional, sizeQuestion]);
    const { sent } = await play(session, [fruitSelect, toppingsInput, sizeSelect], {
      kind: "form",
      values: { q1: "Banana", q2: ["Cream", "Nuts"], q3: "Small" },
    });
    expect(sent).toEqual([
      { value: "2. Banana - Yellow and soft" },
      { value: "1,2" },
      { value: "1. Small" },
    ]);
  });

  it("cancel -> {cancelled: true} and nothing queued", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const c = await session.onUiRequest(fruitSelect);
    if (c.kind !== "claim") throw new Error("expected claim");
    expect(await session.respond(c, { kind: "cancel" })).toEqual({
      kind: "respond",
      response: { cancelled: true },
      queued: 0,
    });
  });

  it("rejects an incomplete form without answering Pi", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const c = await session.onUiRequest(fruitSelect);
    if (c.kind !== "claim") throw new Error("expected claim");
    await expect(session.respond(c, { kind: "form", values: { q1: "Apple" } })).rejects.toThrow(
      /choose at least one/,
    );
    await expect(
      session.respond(c, { kind: "form", values: { q1: "Kiwi", q2: ["Nuts"] } }),
    ).rejects.toThrow(/unknown option/);
  });

  it("queued answers expire when the tool call ends", async () => {
    const { session } = harness();
    await start(session, [fruitQuestion, toppingsQuestion]);
    const c = await session.onUiRequest(fruitSelect);
    if (c.kind !== "claim") throw new Error("expected claim");
    await session.respond(c, { kind: "form", values: { q1: "Apple", q2: ["Nuts"] } });
    expect(session.queuedAnswers()).toEqual({ [CALL]: 1 });
    await session.onToolEnd({
      toolCallId: CALL,
      name: "ask_user_question",
      args: {},
      result: {},
      isError: true,
    });
    expect(session.queuedAnswers()).toEqual({});
    expect(await session.onUiRequest(toppingsInput)).toMatchObject({
      kind: "claim",
      adapterId: null,
    });
  });

  it("leaves dialogs to generic when the tool args are unknown or do not match", async () => {
    const { session } = harness();
    expect(await session.onUiRequest(fruitSelect)).toMatchObject({
      kind: "claim",
      adapterId: null,
    });
    await start(session, [sizeQuestion]);
    expect(await session.onUiRequest(fruitSelect)).toMatchObject({
      kind: "claim",
      adapterId: null,
    });
  });
});
