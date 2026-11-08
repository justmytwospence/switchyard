import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentChannel } from "../src/bridge/agent-channel.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const marker = (humanInputId: string) => ({
  type: "custom",
  customType: "switchyard-human-input",
  data: { version: 1, humanInputId },
});
const message = (deliveryId: string, customType = "switchyard-inbox") => ({
  type: "custom_message",
  customType,
  details: { deliveryId },
});

function fixture(initialBranch: any[] = []) {
  let branch = [...initialBranch];
  const allEntries = [...branch];
  const sent: any[] = [];
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    const entry = { type: "custom", customType, data };
    branch.push(entry);
    allEntries.push(entry);
  });
  const channel = createAgentChannel({
    send: (record) => {
      sent.push(record);
      return true;
    },
    getContext: () => ({
      sessionManager: {
        getSessionId: () => "native",
        getBranch: () => branch,
        getEntries: () => allEntries,
      },
    }),
    appendEntry,
    mode: "terminal",
    getCapabilities: () => ({
      agentTools: true,
      messageDelivery: true,
      editorDraftGuard: true,
      toolPolicy: false,
    }),
    policyRequired: false,
  });
  channel.onConnect();
  cleanup.push(() => channel.close());
  const context = () => {
    channel.announce();
    return sent.at(-1).context;
  };
  return {
    channel,
    appendEntry,
    context,
    sent,
    branch: () => branch,
    setBranch: (entries: any[]) => {
      branch = entries;
    },
  };
}

describe("human input marker replay", () => {
  it("does not append any existing branch marker or reset later causality", () => {
    const f = fixture([
      marker("old"),
      message("earlier-message"),
      marker("latest"),
      message("latest-message", "switchyard-completion"),
    ]);
    const before = [...f.branch()];
    expect(f.channel.noteHumanInput("old")).toBe("old");
    expect(f.channel.noteHumanInput("latest")).toBe("latest");
    expect(f.channel.noteHumanInput("old")).toBe("old");
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.branch()).toEqual(before);
    expect(f.context()).toEqual({ humanInputId: "latest", causalMessageId: "latest-message" });
  });

  it("acknowledges input.human replay idempotently after reload", () => {
    const f = fixture([marker("old"), marker("latest"), message("notification")]);
    const header = {
      type: "bridge.command",
      runtimeId: f.channel.runtimeId,
      nativeSessionId: "native",
      bindingId: "binding",
    };
    f.channel.receive({
      ...header,
      requestId: "configure",
      method: "configure",
      args: {
        version: 1,
        sessionId: "session",
        runtimeId: f.channel.runtimeId,
        nativeSessionId: "native",
        bindingId: "binding",
        features: ["agentRequests.v1"],
        coordinatorConnected: true,
        policyRequired: false,
        sessionUrl: null,
      },
    });
    f.channel.receive({
      ...header,
      requestId: "replay",
      method: "input.human",
      args: { humanInputId: "old" },
    });
    expect(f.sent.find((r) => r.requestId === "replay")).toMatchObject({
      ok: true,
      result: { humanInputId: "old" },
    });
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.context()).toEqual({ humanInputId: "latest", causalMessageId: "notification" });
  });

  it("only deduplicates against the current branch, not abandoned branch markers", () => {
    const f = fixture([marker("abandoned")]);
    f.setBranch([marker("current"), message("notification")]);
    expect(f.channel.noteHumanInput("abandoned")).toBe("abandoned");
    expect(f.appendEntry).toHaveBeenCalledExactlyOnceWith("switchyard-human-input", {
      version: 1,
      humanInputId: "abandoned",
    });
    expect(f.context()).toEqual({ humanInputId: "abandoned", causalMessageId: null });
  });

  it("appends genuinely new and generated human input markers and resets causality", () => {
    const f = fixture([marker("old"), message("notification")]);
    expect(f.channel.noteHumanInput("new")).toBe("new");
    expect(f.context()).toEqual({ humanInputId: "new", causalMessageId: null });
    f.branch().push(message("later"));
    const generated = f.channel.noteHumanInput();
    expect(generated).not.toBe("new");
    expect(f.context()).toEqual({ humanInputId: generated, causalMessageId: null });
    expect(f.appendEntry).toHaveBeenCalledTimes(2);
  });
});
