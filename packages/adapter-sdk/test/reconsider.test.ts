import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/index.js";
import { inline, sink } from "./helpers.js";

describe("reconsidering a generic presentation", () => {
  it("does not consume an earlier answer while a semantic update enriches the question", async () => {
    const registry = new AdapterRegistry();
    registry.setAdapters([
      inline("questions", {
        onToolStart(_event, ctx) {
          ctx.queueAnswers({ method: "select" }, [{ value: "yes" }]);
        },
      }),
    ]);
    const output = sink();
    const session = registry.openSession({ sessionId: "ses_reconsider", emit: output.emit });
    await session.onToolStart({ toolCallId: "tool-1", name: "questions", args: {} });
    const request = {
      id: "ui-1",
      method: "select" as const,
      title: "Continue?",
      options: ["yes", "no"],
    };
    const reconsidered = await session.onUiRequest(request, { consumeQueuedAnswers: false });
    expect(reconsidered.kind).toBe("claim");
    expect(session.queuedAnswers()).toEqual({ "tool-1": 1 });
    const actual = await session.onUiRequest(request);
    expect(actual).toMatchObject({ kind: "queued", response: { value: "yes" } });
    expect(session.queuedAnswers()).toEqual({});
  });
});
