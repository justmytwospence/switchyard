import type { AttentionItem, PushPayload } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type PushSender, requireService } from "../src/index.js";
import { enrollDevice, startCoordinator, type TestCoordinator, until } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

type Dev = { deviceId: string; credential: string; cookie: string | null };

/** Call the API as a device: bearer for terminals, cookie + CSRF headers for browsers. */
function as(d: Dev, method: string, path: string, body?: unknown) {
  if (d.credential) return t!.api(method, path, { token: d.credential, body });
  return t!.api(method, path, {
    cookie: d.cookie!,
    body,
    headers: { "x-switchyard-request": "1", origin: t!.c.localUrl },
  });
}

interface Sent {
  endpoint: string;
  payload: PushPayload;
}

async function setup(fail: Record<string, number> = {}) {
  const sent: Sent[] = [];
  const sender: PushSender = async (sub, payload) => {
    if (fail[sub.endpoint])
      throw Object.assign(new Error("gone"), { statusCode: fail[sub.endpoint] });
    sent.push({ endpoint: sub.endpoint, payload });
  };
  t = await startCoordinator({ pushSender: sender });
  const now = new Date(t.clock.now).toISOString();
  t.c.store.putProject({
    id: "prj_n",
    name: "Shop",
    repoIdentity: "local:n",
    defaultProfileId: null,
    defaultHostId: null,
    maxConcurrentRuns: 1,
    automationEnabled: true,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    createdAt: now,
    updatedAt: now,
  });
  const devices = {
    phone: await enrollDevice(t, "pwa", "phone"),
    oldPhone: await enrollDevice(t, "pwa", "old phone"),
    laptop: await enrollDevice(t, "browser", "laptop"),
    term: await enrollDevice(t, "terminal", "terminal"),
  };
  for (const [name, d] of Object.entries(devices)) {
    if (name === "term") continue;
    const r = await as(d, "POST", "/api/push/subscriptions", {
      endpoint: `https://push.example/${name}`,
      keys: { p256dh: "p", auth: "a" },
    });
    expect(r.status).toBe(201);
    expect(r.body.push).toEqual({ subscribed: true, permission: "granted" });
  }
  // phone seen most recently.
  for (const [d, ago] of [
    [devices.phone, 1000],
    [devices.oldPhone, 60_000],
  ] as const) {
    const dev = t.c.store.devices.require(d.deviceId);
    t.c.store.putDevice({ ...dev, lastSeenAt: new Date(t.clock.now - ago).toISOString() });
  }
  const router = requireService(t.c.ctx, "notifications");
  router.stop(); // drive it directly
  return { sent, devices, router };
}

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `att_${Math.random().toString(36).slice(2)}`,
    sessionId: "ses_n",
    taskId: null,
    projectId: "prj_n",
    reason: "needs_input",
    severity: "warning",
    summary: "Pick a database",
    interactionId: "int_1",
    deepLink: "/code/ses_n?interaction=int_1",
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function presence(
  deviceId: string,
  p: { foregroundMs?: number | null; interactedAgoMs?: number | null; viewing?: string | null },
) {
  const now = t!.clock.now;
  t!.c.store.upsertPresence({
    deviceId,
    foregroundUntil:
      p.foregroundMs === undefined || p.foregroundMs === null
        ? null
        : new Date(now + p.foregroundMs).toISOString(),
    interactedAt:
      p.interactedAgoMs === undefined || p.interactedAgoMs === null
        ? null
        : new Date(now - p.interactedAgoMs).toISOString(),
    viewingSessionId: p.viewing ?? null,
    updatedAt: new Date(now).toISOString(),
  });
}

describe("notification routing", () => {
  it("viewing the session with a live foreground lease stays inline", async () => {
    const { sent, devices, router } = await setup();
    presence(devices.laptop.deviceId, {
      foregroundMs: 30_000,
      viewing: "ses_n",
      interactedAgoMs: 1000,
    });
    expect(await router.route(item())).toEqual({
      action: "inline",
      deviceId: devices.laptop.deviceId,
    });
    expect(sent).toHaveLength(0);
  });

  it("an expired lease no longer counts as viewing", async () => {
    const { sent, devices, router } = await setup();
    presence(devices.laptop.deviceId, { foregroundMs: -1000, viewing: "ses_n" });
    const d = await router.route(item());
    expect(d).toMatchObject({ action: "push", target: "mobile", deviceId: devices.phone.deviceId });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/phone"]);
  });

  it("a recently active desktop browser gets the push and mobile is suppressed", async () => {
    const { sent, devices, router } = await setup();
    presence(devices.laptop.deviceId, {
      interactedAgoMs: 2 * 60_000,
      viewing: "ses_other",
      foregroundMs: 30_000,
    });
    const d = await router.route(item());
    expect(d).toMatchObject({
      action: "push",
      target: "desktop",
      deviceId: devices.laptop.deviceId,
    });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/laptop"]);
  });

  it("a recently active terminal suppresses mobile without a push", async () => {
    const { sent, devices, router } = await setup();
    presence(devices.term.deviceId, { interactedAgoMs: 60_000 });
    expect(await router.route(item())).toEqual({
      action: "suppressed",
      reason: "desktop_active",
      deviceId: devices.term.deviceId,
    });
    expect(sent).toHaveLength(0);
  });

  it("desktop activity older than 5 minutes routes to the preferred mobile device", async () => {
    const { sent, devices, router } = await setup();
    presence(devices.laptop.deviceId, { interactedAgoMs: 10 * 60_000 });
    const s = await t!.admin("PATCH", "/api/me/notification-settings", {
      preferredDeviceId: devices.oldPhone.deviceId,
    });
    expect(s.body.preferredDeviceId).toBe(devices.oldPhone.deviceId);
    const d = await router.route(item());
    expect(d).toMatchObject({
      action: "push",
      target: "mobile",
      deviceId: devices.oldPhone.deviceId,
    });
    expect(sent.map((x) => x.endpoint)).toEqual(["https://push.example/oldPhone"]);
  });

  it("without a preference the most recently seen PWA gets it, with the protocol payload", async () => {
    const { sent, devices, router } = await setup();
    const d = await router.route(item({ sessionId: "ses_n" }));
    expect(d).toMatchObject({ deviceId: devices.phone.deviceId });
    expect(sent[0]!.payload).toEqual({
      type: "show",
      title: "Shop · Switchyard",
      body: "Needs input: Pick a database",
      tag: "session-ses_n",
      url: "/code/ses_n?interaction=int_1",
      renotify: true,
    });
  });

  it("quiet hours suppress the push; private previews hide the summary", async () => {
    const { sent, router } = await setup();
    const hhmm = (ms: number) => new Date(t!.clock.now + ms).toISOString().slice(11, 16);
    await t!.admin("PATCH", "/api/me/notification-settings", {
      quietHours: { start: hhmm(-3_600_000), end: hhmm(3_600_000), timezone: "UTC" },
    });
    expect(await router.route(item())).toMatchObject({
      action: "suppressed",
      reason: "quiet_hours",
    });
    expect(sent).toHaveLength(0);
    await t!.admin("PATCH", "/api/me/notification-settings", {
      quietHours: null,
      privatePreviews: true,
    });
    await router.route(item({ reason: "failed", summary: "Checks failed: npm test" }));
    expect((sent[0]!.payload as { body: string }).body).toBe("Failed: Open Switchyard to view");
  });

  it("resolving clears the notification on the device last notified", async () => {
    const { sent, router } = await setup();
    const it1 = item();
    await router.route(it1);
    expect(await router.route(it1)).toEqual({ action: "suppressed", reason: "already_notified" });
    expect(await router.clear({ ...it1, resolvedAt: new Date().toISOString() })).toBe(true);
    expect(sent.map((s) => s.payload)).toEqual([
      expect.objectContaining({ type: "show" }),
      { type: "clear", tag: "session-ses_n" },
    ]);
    expect(t!.c.store.getNotification("ses_n")).toBeUndefined();
  });

  it("410 from the push service deletes the subscription", async () => {
    const { devices, router } = await setup({ "https://push.example/phone": 410 });
    const d = await router.route(item());
    expect(d).toMatchObject({ action: "push", sent: 0 });
    expect(t!.c.store.listPushSubscriptions(devices.phone.deviceId)).toHaveLength(0);
    expect(t!.c.store.devices.require(devices.phone.deviceId).push.subscribed).toBe(false);
  });

  it("routes raised attention end to end and serves VAPID and test pushes", async () => {
    const { sent, devices, router } = await setup();
    router.start();
    const key = await as(devices.phone, "GET", "/api/push/vapid-public-key");
    expect(typeof key.body.publicKey).toBe("string");
    expect(key.body.publicKey).toBe(
      (await t!.admin("GET", "/api/push/vapid-public-key")).body.publicKey,
    );
    t!.c.attention.raise({
      reason: "failed",
      taskId: "tsk_x",
      projectId: "prj_n",
      summary: "Launch failed",
    });
    await until(() => sent.length === 1);
    expect(sent[0]!.payload).toMatchObject({ tag: "task-tsk_x", url: "/tasks/tsk_x" });
    t!.c.attention.resolve({ taskId: "tsk_x" });
    await until(() => sent.length === 2);
    expect(sent[1]!.payload).toEqual({ type: "clear", tag: "task-tsk_x" });

    const test = await as(devices.laptop, "POST", "/api/push/test");
    expect(test.body).toMatchObject({ ok: true, sent: 1 });
    expect(sent[2]!.payload).toMatchObject({ body: "Test notification from Switchyard" });
    const none = await as(devices.term, "POST", "/api/push/test");
    expect(none.status).toBe(409);
    const del = await as(devices.laptop, "DELETE", "/api/push/subscriptions", {
      endpoint: "https://push.example/laptop",
    });
    expect(del.body.push.subscribed).toBe(false);
  });
});
