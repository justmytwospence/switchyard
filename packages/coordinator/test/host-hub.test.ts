import type { Session } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSettled } from "../src/index.js";
import {
  enrollDevice,
  enrollHost,
  FakeClient,
  FakeHost,
  hostSession,
  NO_REPLY,
  sleep,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  await t?.cleanup();
  t = undefined;
});

async function connect(tc: TestCoordinator, creds: { hostId: string; credential: string }) {
  const h = await FakeHost.connect(tc, creds);
  hosts.push(h);
  return h;
}

function eventCount(tc: TestCoordinator, type: string): number {
  return (
    tc.c.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(type) as {
      n: number;
    }
  ).n;
}

describe("host link", () => {
  it("authenticates hello, welcomes with ackedHostSeq and marks the host connected", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    expect(h.inbox.messages[0]).toEqual({
      type: "welcome",
      coordinatorVersion: expect.any(String),
      ackedHostSeq: 0,
    });
    const host = t.c.store.hosts.require(creds.hostId);
    expect(host.connectivity).toBe("connected");
    expect(host.piVersion).toBe("1.4.0");
    expect(host.piCompatible).toBe(true);
  });

  it("rejects a bad credential", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, "wrong");
    hosts.push(h);
    const first = await h.open();
    expect(first).toMatchObject({ type: "reject", error: { code: "unauthorized" } });
    await until(() => h.closed);
  });

  it("projects events, dedupes by eventId and acks cumulatively", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_a"), { hostSeq: 1, eventId: "e1" });
    const s = t.c.store.sessions.require("ses_a");
    expect(s.hostId).toBe(creds.hostId);
    expect(s.connectivity).toBe("connected");
    expect(s.nativeHandle?.sessionFile).toBe("/tmp/native-1.jsonl");

    const item = {
      id: "itm_1",
      sessionId: "ses_a",
      order: 0,
      at: new Date().toISOString(),
      kind: "user",
      data: { text: "hello" },
    };
    await h.event("transcript.item", item, { hostSeq: 2, eventId: "e2" });
    expect(eventCount(t, "transcript.item")).toBe(1);
    // Duplicate delivery (same eventId) is acked but not applied twice.
    await h.event("transcript.item", item, { hostSeq: 2, eventId: "e2" });
    expect(eventCount(t, "transcript.item")).toBe(1);
    expect(t.c.store.listItems("ses_a").items).toHaveLength(1);
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(2);

    // Invalid payloads are acked and recorded as a diagnostic, never wedging the link.
    await h.event("transcript.item", { bogus: true }, { hostSeq: 3, eventId: "e3" });
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(3);
    expect(eventCount(t, "diagnostic")).toBe(1);
  });

  it("persists ackedHostSeq across reconnects and coordinator restarts; replays dedupe", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    let h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_b"), { hostSeq: 1, eventId: "b1" });
    await h.event("session.updated", hostSession("ses_b", { title: "two" }), {
      hostSeq: 2,
      eventId: "b2",
    });
    await h.close();
    await until(() => t!.c.store.hosts.require(creds.hostId).connectivity === "reconnecting");
    expect(t.c.store.sessions.require("ses_b").connectivity).toBe("reconnecting");

    const dir = t.dir;
    await t.stop();
    t = await startCoordinator({ dir });
    h = await connect(t, creds);
    expect(h.inbox.messages[0]).toMatchObject({ type: "welcome", ackedHostSeq: 2 });
    // Host replays from its outbox: b2 again (already seen), then b3.
    const before = eventCount(t, "session.updated");
    await h.event("session.updated", hostSession("ses_b", { title: "two" }), {
      hostSeq: 2,
      eventId: "b2",
    });
    await h.event("session.updated", hostSession("ses_b", { title: "three" }), {
      hostSeq: 3,
      eventId: "b3",
    });
    expect(t.c.store.sessions.require("ses_b").title).toBe("three");
    expect(eventCount(t, "session.updated")).toBe(before + 1);
    expect(t.c.store.ackedHostSeq(creds.hostId)).toBe(3);
  });

  it("goes reconnecting then unreachable after the timeout", async () => {
    t = await startCoordinator({ unreachableAfterMs: 150 });
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_c"), { hostSeq: 1 });
    const unreachable = new Promise<void>((r) => t!.c.events.once("host.unreachable", () => r()));
    await h.close();
    await until(() => t!.c.store.hosts.require(creds.hostId).connectivity === "reconnecting");
    await unreachable;
    expect(t.c.store.hosts.require(creds.hostId).connectivity).toBe("unreachable");
    expect(t.c.store.sessions.require("ses_c").connectivity).toBe("unreachable");
  });

  it("rejects commands while disconnected and resends pending commands on reconnect", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    await expect(
      t.c.hostHub.send(creds.hostId, { type: "session.importable" }),
    ).rejects.toMatchObject({ code: "host_unreachable" });

    let h = await connect(t, creds);
    h.handler = () => NO_REPLY;
    const pending = t.c.hostHub.request(creds.hostId, { type: "session.importable" });
    const first = await h.waitForCommand("session.importable");
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));

    h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(h);
    h.handler = () => [{ fake: true }];
    await h.open();
    const resent = await h.waitForCommand("session.importable");
    expect(resent.commandId).toBe(first.commandId);
    await expect(pending).resolves.toEqual([{ fake: true }]);
  });

  it("withdrawMatching drops matching pending commands of a disconnected host only", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    let h = await connect(t, creds);
    h.handler = () => NO_REPLY;
    const matching = t.c.hostHub.request(
      creds.hostId,
      { type: "session.importable" },
      { commandId: "cont_run_x_1" },
    );
    const other = t.c.hostHub.request(
      creds.hostId,
      { type: "session.importable" },
      { commandId: "other_1" },
    );
    const matchingResult = matching.catch((e) => e);
    await until(() => h.commands.length === 2);
    const isCont = (id: string) => id.startsWith("cont_run_x_");
    expect(t.c.hostHub.withdrawMatching(creds.hostId, isCont, "withdrawn")).toBe(0);
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    expect(t.c.hostHub.withdrawMatching(creds.hostId, isCont, "withdrawn")).toBe(1);
    expect(await matchingResult).toMatchObject({
      code: "host_unreachable",
      details: { withdrawn: true },
    });

    h = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(h);
    h.handler = () => [];
    await h.open();
    await expect(other).resolves.toEqual([]);
    expect(h.commands.map((c) => c.commandId)).toEqual(["other_1"]);
  });

  it("maps error receipts to SwitchyardError and times out silent hosts", async () => {
    t = await startCoordinator({ commandTimeoutMs: 200 });
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    h.handler = (cmd) =>
      cmd.type === "checkout.inspect"
        ? { __error: { code: "not_a_git_repo", message: "nope" } }
        : NO_REPLY;
    await expect(
      t.c.hostHub.request(creds.hostId, { type: "checkout.inspect", path: "/x" }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
    await expect(
      t.c.hostHub.request(creds.hostId, { type: "session.importable" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("emits session.settled when a session goes from running to idle", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const settled: SessionSettled[] = [];
    t.c.events.on("session.settled", (s) => {
      settled.push(s);
    });
    await h.event("session.updated", hostSession("ses_d", { runtime: "running" }));
    await h.event("session.updated", hostSession("ses_d", { runtime: "waiting_input" }));
    expect(settled).toHaveLength(0);
    await h.event(
      "session.updated",
      hostSession("ses_d", { runtime: "idle", lastAssistantText: "done\nSWITCHYARD: DONE" }),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.previousRuntime).toBe("waiting_input");
    expect(settled[0]!.lastAssistantText).toContain("SWITCHYARD: DONE");
    expect(settled[0]!.aborted).toBe(false);
  });

  it("emits host.connected with reconnect flag", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const seen: boolean[] = [];
    t.c.events.on("host.connected", (e) => {
      seen.push(e.reconnect);
    });
    let h = await connect(t, creds);
    await h.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    h = await connect(t, creds);
    expect(seen).toEqual([false, true]);
  });

  it("keeps coordinator-owned session fields when the host updates a session", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    await h.event("session.updated", hostSession("ses_e"));
    const s = t.c.store.sessions.require("ses_e");
    t.c.store.putSession({ ...s, projectId: "prj_x", taskId: "tsk_x" } as Session);
    await h.event(
      "session.updated",
      hostSession("ses_e", { runtime: "running", nativeHandle: null }),
    );
    const after = t.c.store.sessions.require("ses_e");
    expect(after.projectId).toBe("prj_x");
    expect(after.taskId).toBe("tsk_x");
    expect(after.runtime).toBe("running");
    expect(after.nativeHandle?.sessionFile).toBe("/tmp/native-1.jsonl");
  });

  it("forwards stream deltas to clients without persisting them", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const dev = await enrollDevice(t);
    const client = await FakeClient.connect(t, { token: dev.credential });
    await client.hello(null);
    const seqBefore = t.c.store.currentSeq();
    h.sendRaw({
      type: "stream",
      delta: { sessionId: "ses_s", itemId: "itm_s", kind: "text", delta: "Hel" },
    });
    const m = await client.inbox.waitFor((x) => x.type === "stream");
    expect(m).toMatchObject({ type: "stream", delta: { delta: "Hel" } });
    await sleep(20);
    expect(t.c.store.currentSeq()).toBe(seqBefore);
    client.close();
  });

  it("serves adapter renderers with sandbox CSP from adapters.updated", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const h = await connect(t, creds);
    const adapter = {
      id: "bg",
      version: "1.0.0",
      tier: "bundled",
      target: { extension: "@x/pi-bg", versionRange: "*", testedVersions: [] },
      capabilities: ["panels"],
      webRenderer: true,
      status: "active",
      detail: null,
    };
    await h.event("adapters.updated", {
      hostId: creds.hostId,
      adapters: [adapter],
      renderers: { bg: "<html><body>bg</body></html>" },
    });
    const r = await t.admin("GET", `/adapter-frames/${creds.hostId}/bg`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("bg</body>");
    expect(r.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts;/);
    expect(r.headers.get("content-security-policy")).not.toMatch(/allow-same-origin/);
    expect((await t.admin("GET", `/adapter-frames/${creds.hostId}/nope`)).status).toBe(404);
    expect((await t.api("GET", `/adapter-frames/${creds.hostId}/bg`)).status).toBe(401);
    const host = await t.admin("GET", `/api/hosts/${creds.hostId}`);
    expect(host.body.adapters).toHaveLength(1);
  });
});
