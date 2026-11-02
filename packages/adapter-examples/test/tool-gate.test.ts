import { validateUINode } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { gateMessageInput, gateSelect, harness } from "./fixtures.js";

describe("tool-gate adapter", () => {
  it("renders the approval as a table, note and one action per option", async () => {
    const { session } = harness();
    const out = await session.onUiRequest(gateSelect);
    if (out.kind !== "claim") throw new Error("expected claim");
    expect(out.adapterId).toBe("tool-gate");
    expect(out.claim.title).toBe("Allow this call? run a shell command");
    const node = validateUINode(out.claim.presentation);
    expect(node).toEqual({
      t: "section",
      title: "Allow this call?",
      children: [
        {
          t: "table",
          columns: ["Field", "Value"],
          rows: [
            ["Action", "run a shell command"],
            ["Target", "rm -rf build"],
            ["Held", "no rule allows this command"],
            ["Agent", "main"],
            ["Rule", "bash rm -rf build"],
            ["Folder", "/work/repo"],
          ],
        },
        { t: "markdown", text: "This removes files in the workspace." },
        {
          t: "actions",
          actions: [
            { id: "option:0", label: "Allow once", tone: "primary" },
            { id: "option:1", label: "Allow rule for this session", tone: "default" },
            { id: "option:2", label: "Allow rule in this project", tone: "default" },
            { id: "option:3", label: "Allow rule everywhere", tone: "default" },
            { id: "option:4", label: "Edit the rule...", tone: "default" },
            { id: "option:5", label: "Block", tone: "danger" },
            { id: "option:6", label: "Block with a message", tone: "danger" },
          ],
        },
      ],
    });
  });

  it.each([
    ["option:0", "Allow once"],
    ["option:3", "Allow rule everywhere"],
    ["option:5", "Block"],
  ])("action %s -> {value: %s}", async (actionId, value) => {
    const { session } = harness();
    const out = await session.onUiRequest(gateSelect);
    if (out.kind !== "claim") throw new Error("expected claim");
    expect(await session.respond(out, { kind: "action", actionId })).toEqual({
      kind: "respond",
      response: { value },
      queued: 0,
    });
  });

  it("cancel -> {cancelled: true}; unknown actions are rejected", async () => {
    const { session } = harness();
    const out = await session.onUiRequest(gateSelect);
    if (out.kind !== "claim") throw new Error("expected claim");
    expect(await session.respond(out, { kind: "cancel" })).toMatchObject({
      response: { cancelled: true },
    });
    await expect(session.respond(out, { kind: "action", actionId: "option:99" })).rejects.toThrow(
      /unknown approval action/,
    );
  });

  it("leaves the block-message follow-up to the generic renderer", async () => {
    const { session } = harness();
    const out = await session.onUiRequest(gateSelect);
    if (out.kind !== "claim") throw new Error("expected claim");
    await session.respond(out, { kind: "action", actionId: "option:6" });
    const follow = await session.onUiRequest(gateMessageInput);
    expect(follow).toMatchObject({
      kind: "claim",
      adapterId: null,
      claim: { title: "Message for the agent" },
    });
  });

  it("does not claim other selects", async () => {
    const { session } = harness();
    const out = await session.onUiRequest({
      id: "x",
      method: "select",
      title: "Pick a fruit",
      options: ["Apple"],
    });
    expect(out).toMatchObject({ adapterId: null });
  });
});
