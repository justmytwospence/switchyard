import type { AttentionItem, PushPayload } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getService, type RouteDecision } from "../../src/index.js";
import {
  type Device,
  Integration,
  steps,
  type WsClient,
  waitFor,
  waitForValue,
} from "./harness.js";

/**
 * Spec §16/§19: notification routing by presence, with a stubbed web-push sender. Attention comes
 * from real Pi questions; presence comes from real `/ws/client` presence frames.
 */
describe("notification routing", { timeout: 180_000 }, () => {
  let env: Integration;
  let tablet: Device;
  let sid: string;
  const decisions: { item: AttentionItem; decision: RouteDecision }[] = [];
  const sockets: Record<string, WsClient> = {};
  const endpoint = (d: Device) => `https://push.example.test/${d.id}`;

  beforeAll(async () => {
    env = await Integration.create();
    const { terminal, desktop, mobile } = env.devices!;
    tablet = await env.enrollDevice("pwa", "Tablet");
    for (const d of [desktop, mobile, tablet]) {
      await env.ok("POST", "/api/push/subscriptions", {
        as: d,
        body: { endpoint: endpoint(d), keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      });
    }
    // The phone is the preferred mobile device; the tablet was seen more recently.
    await env.ok("PATCH", `/api/devices/${mobile.id}`, { body: { preferredMobile: true } });
    await env.ok("GET", "/api/me", { as: tablet });
    for (const d of [terminal, desktop, mobile, tablet]) sockets[d.id] = await env.connect(d);

    const router = getService(env.c.ctx, "notifications")!;
    const route = router.route.bind(router);
    router.route = async (item: AttentionItem) => {
      const decision = await route(item);
      decisions.push({ item, decision });
      return decision;
    };
    const s = await env.createSession(terminal, "", "Notify me");
    sid = s.id;
    await env.waitSession(sid, (x) => x.runtime === "idle", "idle");
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

  async function presence(
    d: Device,
    p: { foreground: boolean; interactedAt: string | null; viewing: { sessionId: string } | null },
  ) {
    sockets[d.id]!.presence(p);
    await waitFor(() => {
      const row = env.c.store.listPresence().find((x) => x.deviceId === d.id);
      return (
        !!row &&
        row.interactedAt === p.interactedAt &&
        row.viewingSessionId === (p.viewing?.sessionId ?? null) &&
        (row.foregroundUntil !== null) === p.foreground
      );
    }, "presence stored");
  }

  /** Ask a real question; resolve with the routing decision for its attention item. */
  async function ask(): Promise<{ item: AttentionItem; decision: RouteDecision; pushes: number }> {
    const pushes = env.pushes.length;
    const from = decisions.length;
    await env.ok("POST", `/api/sessions/${sid}/prompt`, {
      as: env.devices!.terminal,
      body: { text: `Question ${steps("select", "done")}` },
    });
    const q = await env.pendingInteraction(sid);
    const d = await waitForValue(
      () => decisions.slice(from).find((x) => x.item.interactionId === q.id),
      "routing decision",
    );
    return { ...d, pushes };
  }

  async function answer() {
    const q = await env.pendingInteraction(sid);
    const before = env.session(sid).lastActivityAt;
    await env.ok("POST", `/api/interactions/${q.id}/answer`, {
      as: env.devices!.desktop,
      body: { revision: q.revision, response: { kind: "form", values: { value: "Apple" } } },
    });
    await env.waitSession(
      sid,
      (x) =>
        x.runtime === "idle" &&
        x.lastActivityAt !== before &&
        /DONE/.test(x.lastAssistantText ?? ""),
      "answered and settled",
    );
  }

  const shows = (from: number): { endpoint: string; payload: PushPayload }[] =>
    env.pushes.slice(from).filter((p) => p.payload.type === "show");

  it("the client viewing the session gets it inline: no push", async () => {
    const { desktop } = env.devices!;
    await presence(desktop, { foreground: true, interactedAt: iso(), viewing: { sessionId: sid } });
    const { item, decision, pushes } = await ask();
    expect(item.reason).toBe("needs_input");
    expect(item.deepLink).toBe(`/code/${sid}?interaction=${item.interactionId}`);
    expect(decision).toEqual({ action: "inline", deviceId: desktop.id });
    await answer();
    expect(env.pushes.length).toBe(pushes);
  });

  it("a recent desktop interaction pushes to that desktop only, tagged session-<id>", async () => {
    const { desktop } = env.devices!;
    await presence(desktop, { foreground: true, interactedAt: iso(), viewing: null });
    const { item, decision, pushes } = await ask();
    expect(decision).toMatchObject({
      action: "push",
      target: "desktop",
      deviceId: desktop.id,
      sent: 1,
    });
    const sent = shows(pushes);
    expect(sent.map((p) => p.endpoint)).toEqual([endpoint(desktop)]);
    expect(sent[0]!.payload).toMatchObject({
      type: "show",
      tag: `session-${sid}`,
      url: `/code/${sid}?interaction=${item.interactionId}`,
    });
    await answer();
    // Answering resolves the attention and clears the same tag on the same device.
    await waitFor(() => env.pushes.slice(pushes).some((p) => p.payload.type === "clear"), "clear");
    const clear = env.pushes.slice(pushes).find((p) => p.payload.type === "clear")!;
    expect(clear).toEqual({
      endpoint: endpoint(desktop),
      payload: { type: "clear", tag: `session-${sid}` },
    });
  });

  it("a recent terminal interaction (no push subscription) suppresses mobile pushes", async () => {
    const { desktop, terminal } = env.devices!;
    await presence(desktop, { foreground: false, interactedAt: iso(-10 * 60_000), viewing: null });
    await presence(terminal, { foreground: true, interactedAt: iso(), viewing: null });
    const { decision, pushes } = await ask();
    expect(decision).toEqual({
      action: "suppressed",
      reason: "desktop_active",
      deviceId: terminal.id,
    });
    await answer();
    expect(env.pushes.length).toBe(pushes);
  });

  it("otherwise the preferred mobile device gets the push", async () => {
    const { terminal, mobile } = env.devices!;
    await presence(terminal, { foreground: false, interactedAt: iso(-10 * 60_000), viewing: null });
    const { decision, pushes } = await ask();
    expect(decision).toMatchObject({
      action: "push",
      target: "mobile",
      deviceId: mobile.id,
      sent: 1,
    });
    const sent = shows(pushes);
    expect(sent.map((p) => p.endpoint)).toEqual([endpoint(mobile)]);
    expect(sent[0]!.payload.type === "show" && sent[0]!.payload.tag).toBe(`session-${sid}`);
    await answer();

    // Without a preferred device, the most recently seen PWA gets it.
    await env.ok("PATCH", `/api/devices/${mobile.id}`, { body: { preferredMobile: false } });
    await env.ok("GET", "/api/me", { as: tablet });
    const next = await ask();
    expect(next.decision).toMatchObject({ action: "push", target: "mobile", deviceId: tablet.id });
    expect(shows(next.pushes).map((p) => p.endpoint)).toEqual([endpoint(tablet)]);
    await answer();
    await env.ok("PATCH", `/api/devices/${mobile.id}`, { body: { preferredMobile: true } });
  });

  it("quiet hours suppress the push but keep the attention item", async () => {
    const now = new Date();
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const start = hhmm(new Date(now.getTime() - 60 * 60_000));
    const end = hhmm(new Date(now.getTime() + 60 * 60_000));
    await env.ok("PATCH", "/api/me/notification-settings", {
      body: { quietHours: { start, end, timezone: "UTC" } },
    });
    try {
      const { item, decision, pushes } = await ask();
      expect(decision).toEqual({
        action: "suppressed",
        reason: "quiet_hours",
        deviceId: env.devices!.mobile.id,
      });
      const open = await env.ok("GET", `/api/attention?sessionId=${sid}`);
      expect(open.map((a: AttentionItem) => a.id)).toContain(item.id);
      await answer();
      expect(env.pushes.length).toBe(pushes);
    } finally {
      await env.ok("PATCH", "/api/me/notification-settings", { body: { quietHours: null } });
    }
  });

  it("every notification used the session tag", () => {
    const tags = new Set(env.pushes.map((p) => p.payload.tag));
    expect([...tags]).toEqual([`session-${sid}`]);
  });
});
