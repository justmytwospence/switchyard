import { existsSync } from "node:fs";
import type { EventEnvelope, Session, TranscriptItem } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, waitFor } from "./harness.js";

/** Spec §19: simultaneous terminal/web access to one native session. */
describe("shared session (terminal + web on one native Pi session)", { timeout: 120_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const durable = (events: EventEnvelope[], sessionId: string) =>
    events
      .filter((e) => e.sessionId === sessionId)
      .map((e) => ({ seq: e.seq, id: e.id, type: e.type, data: e.data }));

  it("both clients see identical durable events and transcript items for one session", async () => {
    const { terminal, desktop } = env.devices!;
    const term = await env.connect(terminal);
    const web = await env.connect(desktop);

    // The terminal creates the session and prompts; the browser only watches.
    const created = await env.createSession(terminal, "", "Shared");
    const sid = created.id;
    await env.waitSession(sid, (s) => s.runtime === "idle", "session idle");
    const r1 = await env.api("POST", `/api/sessions/${sid}/prompt`, {
      as: terminal,
      body: { text: "hello from the terminal" },
    });
    expect(r1.status).toBe(200);
    await env.waitSession(
      sid,
      (s) => s.runtime === "idle" && s.lastAssistantText !== null,
      "settled",
    );

    // Then the browser prompts the same session (cookie + CSRF header + trusted Origin).
    const before = env.session(sid).lastActivityAt;
    const r2 = await env.api("POST", `/api/sessions/${sid}/prompt`, {
      as: desktop,
      body: { text: `browser turn ${steps("done")}` },
    });
    expect(r2.status).toBe(200);
    await env.waitSession(
      sid,
      (s) =>
        s.runtime === "idle" &&
        s.lastActivityAt !== before &&
        /SWITCHYARD: DONE/.test(s.lastAssistantText ?? ""),
      "second settle",
    );

    // Both sockets caught up to the coordinator's head.
    const head = env.c.store.currentSeq();
    await waitFor(() => term.lastSeq >= head && web.lastSeq >= head, "clients caught up");

    const a = durable(term.events, sid);
    const b = durable(web.events, sid);
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);

    // Transcript items over the socket match the REST transcript for both devices.
    const itemsA = a
      .filter((e) => e.type === "transcript.item")
      .map((e) => e.data as TranscriptItem);
    const restT = (await env.ok("GET", `/api/sessions/${sid}/transcript`, { as: terminal }))
      .items as TranscriptItem[];
    const restW = (await env.ok("GET", `/api/sessions/${sid}/transcript`, { as: desktop }))
      .items as TranscriptItem[];
    expect(restW).toEqual(restT);
    const latest = new Map<string, TranscriptItem>();
    for (const it of itemsA) latest.set(it.id, it);
    const byId = new Map(restT.map((i) => [i.id, i]));
    for (const [id, it] of latest) expect(byId.get(id)).toEqual(it);
    const users = restT.filter((i) => i.kind === "user");
    expect(users.map((u) => (u.data as { text: string }).text)).toEqual([
      "hello from the terminal",
      `browser turn ${steps("done")}`,
    ]);

    // One native session: the same session file everywhere, never replaced.
    const viaTerm = (await env.ok("GET", `/api/sessions/${sid}`, { as: terminal })) as Session;
    const viaWeb = (await env.ok("GET", `/api/sessions/${sid}`, { as: desktop })) as Session;
    const file = viaTerm.nativeHandle!.sessionFile;
    expect(viaWeb.nativeHandle).toEqual(viaTerm.nativeHandle);
    expect(created.nativeHandle!.sessionFile).toBe(file);
    expect(existsSync(file)).toBe(true);
    const handles = new Set(
      a
        .filter((e) => e.type === "session.updated")
        .map((e) => (e.data as Session).nativeHandle?.sessionFile)
        .filter(Boolean),
    );
    expect([...handles]).toEqual([file]);
    expect(env.agent!.spawnedPiProcesses).toBe(1);
  });
});
