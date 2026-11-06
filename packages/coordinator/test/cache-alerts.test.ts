import type { Session } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CacheAlertService, cacheTtlSec, cacheWarning } from "../src/cache-alerts.js";
import { hostSession } from "./helpers.js";
import { cleanupHarness, type Harness, setupHarness } from "./task-helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function sess(over: Record<string, unknown> = {}): Session {
  return {
    runtime: "idle",
    archivedAt: null,
    model: null,
    cacheAlert: { ttlSec: null, warnedFor: null },
    promptCache: {
      at: iso(T0),
      provider: "anthropic",
      model: "claude",
      cacheRead: 100,
      cacheWrite: 0,
      cacheWrite1h: 0,
    },
    ...over,
  } as unknown as Session;
}

describe("cacheTtlSec", () => {
  it("prefers the override, then Pi metadata, then the anthropic fallback", () => {
    expect(cacheTtlSec(sess({ cacheAlert: { ttlSec: 120, warnedFor: null } }))).toBe(120);
    const model = {
      provider: "anthropic",
      id: "claude",
      promptCache: { short: 300, long: 3600 },
    };
    expect(cacheTtlSec(sess({ model }))).toBe(300);
    const long = sess({
      model,
      promptCache: { ...sess().promptCache, cacheWrite1h: 5 },
    });
    expect(cacheTtlSec(long)).toBe(3600);
    expect(cacheTtlSec(sess())).toBe(300);
    expect(cacheTtlSec(sess({ promptCache: { ...sess().promptCache, provider: "x" } }))).toBeNull();
  });
});

describe("cacheWarning", () => {
  it("warns min(300s, ttl/2) before expiry and ignores busy or cold sessions", () => {
    expect(cacheWarning(sess(), T0)).toEqual({ expiresAt: T0 + 300_000, warnAt: T0 + 150_000 });
    expect(cacheWarning(sess({ runtime: "running" }), T0)).toBeNull();
    expect(
      cacheWarning(sess({ promptCache: { ...sess().promptCache, cacheRead: 0 } }), T0),
    ).toBeNull();
    expect(cacheWarning(sess({ cacheAlert: null }), T0)).toBeNull();
  });
});

describe("CacheAlertService", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await cleanupHarness(h);
    h = undefined;
  });

  const cache = (at: number) => ({
    at: iso(at),
    provider: "anthropic",
    model: "claude",
    cacheRead: 10,
    cacheWrite: 0,
    cacheWrite1h: 0,
  });

  it("warns once, survives a new service, and resolves on a newer reply or expiry", async () => {
    h = await setupHarness();
    const c = h.t.c;
    await h.host.event("session.updated", hostSession("ses_k", { promptCache: cache(T0) }));
    c.store.putSession({
      ...c.store.sessions.require("ses_k"),
      cacheAlert: { ttlSec: null, warnedFor: null },
    });
    const svc = new CacheAlertService(c, { tickMs: 0 });
    const open = () => c.attention.open({ sessionId: "ses_k", reason: "cache_expiring" });
    svc.tick(T0 + 100_000); // before the window
    expect(open()).toHaveLength(0);
    svc.tick(T0 + 160_000);
    expect(open()).toHaveLength(1);
    expect(c.store.sessions.require("ses_k").cacheAlert?.warnedFor).toBe(iso(T0));
    // A fresh service (restart) does not warn again for the same reply.
    c.attention.resolve({ sessionId: "ses_k", reason: "cache_expiring" });
    new CacheAlertService(c, { tickMs: 0 }).tick(T0 + 170_000);
    expect(open()).toHaveLength(0);
    // A newer reply re-arms the warning; expiry resolves it.
    await h.host.event(
      "session.updated",
      hostSession("ses_k", { promptCache: cache(T0 + 200_000) }),
    );
    svc.tick(T0 + 360_000);
    expect(open()).toHaveLength(1);
    svc.tick(T0 + 501_000);
    expect(open()).toHaveLength(0);
  });

  it("resolves when the alert is turned off", async () => {
    h = await setupHarness();
    const c = h.t.c;
    await h.host.event("session.updated", hostSession("ses_k", { promptCache: cache(T0) }));
    const on = await h.t.admin("POST", "/api/sessions/ses_k/cache-alert", { enabled: true });
    expect(on.body.cacheAlert).toEqual({ ttlSec: null, warnedFor: null });
    new CacheAlertService(c, { tickMs: 0 }).tick(T0 + 160_000);
    expect(c.attention.open({ sessionId: "ses_k", reason: "cache_expiring" })).toHaveLength(1);
    const off = await h.t.admin("POST", "/api/sessions/ses_k/cache-alert", { enabled: false });
    expect(off.body.cacheAlert).toBeNull();
    expect(c.attention.open({ sessionId: "ses_k", reason: "cache_expiring" })).toHaveLength(0);
  });
});
