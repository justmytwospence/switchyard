import type { TranscriptItem } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHarness,
  commandsOf,
  type Harness,
  setupHarness,
  startRun,
} from "./task-helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

const SUB_FILE = "/home/me/.pi/agent/sessions/sub-1.jsonl";

function subagentItem(sessionId: string, status: string): TranscriptItem {
  return {
    id: "itm_sub_row",
    sessionId,
    order: 5,
    at: new Date().toISOString(),
    kind: "subagent",
    data: {
      runId: "sub-run-1",
      label: "researcher",
      status,
      sessionFile: SUB_FILE,
      linkedSessionId: null,
    },
  };
}

function nativeItems(texts: string[]) {
  return texts.map((text, i) => ({
    id: `itm_random_${Math.random().toString(36).slice(2)}`,
    sessionId: "native-sub-1",
    order: i,
    at: new Date().toISOString(),
    kind: i % 2 === 0 ? "user" : "assistant",
    data: { text },
  }));
}

describe("subagent sessions", () => {
  it("links a subagent row to a read-only session that reads its native transcript on open", async () => {
    h = await setupHarness();
    const { run } = await startRun(h);
    const parent = h.t.c.store.sessions.require(run.sessionId!);
    let native = nativeItems(["look into the bug", "found it"]);
    h.override = (cmd) =>
      cmd.type === "session.readNative"
        ? { sessionId: "native-sub-1", cwd: parent.cwd, name: null, items: native }
        : undefined;

    await h.host.event("transcript.item", subagentItem(parent.id, "running"), {
      sessionId: parent.id,
    });
    const stored = h.t.c.store
      .listItems(parent.id, { limit: 100 })
      .items.find((i) => i.id === "itm_sub_row");
    expect(stored?.kind).toBe("subagent");
    const linkedId = stored?.kind === "subagent" ? stored.data.linkedSessionId : null;
    expect(linkedId).toMatch(/^ses_/);
    // The event clients receive carries the link too.
    const event = h.t.c.store
      .eventsAfter(0, 100_000)
      .filter((e) => e.type === "transcript.item")
      .at(-1)!;
    expect((event.data as { data: { linkedSessionId: string } }).data.linkedSessionId).toBe(
      linkedId,
    );

    const sub = h.t.c.store.sessions.require(linkedId!);
    expect(sub).toMatchObject({
      provenance: "subagent",
      readOnly: true,
      runtime: "stopped",
      hostId: parent.hostId,
      projectId: parent.projectId,
      workspaceId: parent.workspaceId,
      nativeHandle: { sessionFile: SUB_FILE },
      subtitle: "running",
    });

    // A status update keeps the same linked session.
    await h.host.event("transcript.item", subagentItem(parent.id, "done"), {
      sessionId: parent.id,
    });
    expect(h.t.c.store.sessions.list().filter((x) => x.provenance === "subagent")).toHaveLength(1);
    expect(h.t.c.store.sessions.require(linkedId!).subtitle).toBe("done");

    // Opening the subagent session reads its native transcript.
    const first = await h.t.admin("GET", `/api/sessions/${linkedId}/transcript`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: TranscriptItem) => i.kind)).toEqual(["user", "assistant"]);
    expect(first.body.items.every((i: TranscriptItem) => i.sessionId === linkedId)).toBe(true);
    expect(h.t.c.store.sessions.require(linkedId!).nativeHandle).toEqual({
      sessionId: "native-sub-1",
      sessionFile: SUB_FILE,
    });
    expect(commandsOf(h.host, "session.readNative")[0]).toMatchObject({ sessionFile: SUB_FILE });

    // Re-opening refreshes (progress) without duplicating items.
    native = nativeItems(["look into the bug", "found it", "now fix it", "fixed"]);
    const second = await h.t.admin("GET", `/api/sessions/${linkedId}/transcript`);
    expect(second.body.items.map((i: TranscriptItem) => i.data)).toEqual(native.map((i) => i.data));
    expect(h.t.c.store.listItems(linkedId!, { limit: 100 }).items).toHaveLength(4);

    // View only: no live control.
    const prompt = await h.t.admin("POST", `/api/sessions/${linkedId}/prompt`, { text: "hi" });
    expect(prompt.status).toBe(403);
    expect(prompt.body.error.message).toBe("Subagent: view only. Live control is not supported.");
    const resume = await h.t.admin("POST", `/api/sessions/${linkedId}/resume`);
    expect(resume.status).toBe(403);
  });

  it("keeps the cached transcript when the host is offline", async () => {
    h = await setupHarness();
    const { run } = await startRun(h);
    h.override = (cmd) =>
      cmd.type === "session.readNative"
        ? { sessionId: "native-sub-1", cwd: "/x", name: null, items: nativeItems(["a", "b"]) }
        : undefined;
    await h.host.event("transcript.item", subagentItem(run.sessionId!, "running"), {
      sessionId: run.sessionId!,
    });
    const sub = h.t.c.store.sessions.list().find((x) => x.provenance === "subagent")!;
    await h.t.admin("GET", `/api/sessions/${sub.id}/transcript`);
    await h.host.close();
    const offline = await h.t.admin("GET", `/api/sessions/${sub.id}/transcript`);
    expect(offline.status).toBe(200);
    expect(offline.body.items).toHaveLength(2);
  });
});
