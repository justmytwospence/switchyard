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
    expect(prompt).toBe("session:ses_1");
    expect(answer).toBe("control:ses_1");
    expect(abort).toBe("control:ses_1");
  });
});
