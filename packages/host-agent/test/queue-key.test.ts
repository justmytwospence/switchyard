import { describe, expect, it } from "vitest";
import { queueKey } from "../src/commands.js";

describe("queueKey", () => {
  it("keeps answers and stop out of the prompt lane", () => {
    const prompt = queueKey({
      type: "session.prompt",
      sessionId: "ses_1",
      text: "/approvals",
      images: [],
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    const answer = queueKey({
      type: "session.answer",
      sessionId: "ses_1",
      interactionId: "int_1",
      revision: 1,
      response: { kind: "cancel" },
      deviceId: "dev_1",
    });
    const abort = queueKey({ type: "session.abort", sessionId: "ses_1", clearQueue: true });
    expect(queueKey({ type: "session.stop", sessionId: "ses_1" })).toBe("control:ses_1");
    expect(prompt).toBe("session:ses_1");
    expect(answer).toBe("control:ses_1");
    expect(abort).toBe("control:ses_1");
  });

  it("routes model and command lookups to the control lane", () => {
    expect(queueKey({ type: "session.models", sessionId: "ses_1" })).toBe("control:ses_1");
    expect(queueKey({ type: "session.commands", sessionId: "ses_1" })).toBe("control:ses_1");
    expect(queueKey({ type: "session.complete", sessionId: "ses_1", text: "/m " })).toBe(
      "control:ses_1",
    );
    for (const type of ["session.tree", "session.export", "session.reload"] as const) {
      expect(queueKey({ type, sessionId: "ses_1" })).toBe("control:ses_1");
    }
    expect(
      queueKey({ type: "session.branch", sessionId: "ses_1", entryId: null, fork: false }),
    ).toBe("session:ses_1");
    expect(
      queueKey({ type: "session.setModel", sessionId: "ses_1", provider: "a", modelId: "b" }),
    ).toBe("session:ses_1");
  });
});
