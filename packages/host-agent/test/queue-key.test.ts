import type { HostCommand } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { queueKey, READ_ONLY_COMMANDS } from "../src/commands.js";

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

describe("read-only and checkout lanes", () => {
  it("runs read-only commands without a queue and serializes mutations per checkout", () => {
    const reads: HostCommand[] = [
      { type: "session.importable" },
      { type: "session.readNative", sessionFile: "/x.jsonl" },
      { type: "checkout.inspect", path: "/r" },
      { type: "projects.scan", folder: "/p" },
      { type: "projects.suggest", days: 30 },
      { type: "workspace.discover", checkoutPath: "/r", worktreeDir: ".worktrees" },
      { type: "workspace.status", path: "/r", base: null },
      { type: "workspace.diff", path: "/r", base: null, file: null },
      { type: "workspace.files", path: "/r", dir: "" },
      { type: "workspace.readFile", path: "/r", file: "a" },
      { type: "dispatch.reconcile", dispatchKey: "k" },
    ];
    expect(new Set(reads.map((c) => c.type))).toEqual(READ_ONLY_COMMANDS);
    for (const c of reads) expect(queueKey(c)).toBeNull();
    expect(
      queueKey({
        type: "workspace.create",
        checkoutPath: "/r",
        branch: "b",
        base: "main",
        setupCommand: null,
        worktreeDir: ".worktrees",
      }),
    ).toBe("checkout:/r");
    expect(
      queueKey({
        type: "workspace.remove",
        path: "/r/.worktrees/b",
        checkoutPath: "/r",
        base: null,
        force: { dirty: false, unmerged: false },
      }),
    ).toBe("checkout:/r");
  });
});
