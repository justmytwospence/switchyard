import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/index.js";
import {
  enrollDevice,
  FakeClient,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator;
afterEach(async () => {
  await t?.cleanup();
});

describe("enrollment", () => {
  it("logs a bootstrap enrollment on first start when no devices exist", async () => {
    let info: { url: string; qrTerminal: string } | null = null;
    t = await startCoordinator({ bootstrap: (i) => (info = i) });
    expect(info).not.toBeNull();
    expect(info!.url).toMatch(/\/enroll#token=[\w-]+$/);
    expect(info!.qrTerminal.length).toBeGreaterThan(50);
  });

  it("never writes the bootstrap enrollment URL or token to the structured log", async () => {
    const lines: string[] = [];
    let info: { url: string; token: string } | null = null;
    t = await startCoordinator({
      logger: createLogger({ level: "info", destination: { write: (s: string) => lines.push(s) } }),
      bootstrap: (i) => (info = i),
    });
    expect(info).not.toBeNull();
    const log = lines.join("");
    expect(log).toContain("bootstrap enrollment URL printed to the console");
    expect(log).not.toContain(info!.token);
    expect(log).not.toContain("/enroll#token=");
  });

  it("creates device enrollments with QR and redeems them once", async () => {
    t = await startCoordinator();
    const e = await t.admin("POST", "/api/enrollments", { kind: "device" });
    expect(e.status).toBe(201);
    expect(e.body.url).toBe(`${t.c.config.publicUrl}/enroll#token=${e.body.token}`);
    expect(e.body.qrSvg).toContain("<svg");
    expect(e.body.command).toBeNull();

    const r = await t.api("POST", "/api/enroll", {
      body: { token: e.body.token, name: "laptop term", kind: "terminal" },
    });
    expect(r.status).toBe(201);
    expect(r.body.credential.length).toBeGreaterThan(20);
    const me = await t.api("GET", "/api/me", { token: r.body.credential });
    expect(me.status).toBe(200);
    expect(me.body.device.name).toBe("laptop term");

    const again = await t.api("POST", "/api/enroll", {
      body: { token: e.body.token, name: "again", kind: "terminal" },
    });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("enrollment_used");
  });

  it("rejects expired enrollments", async () => {
    t = await startCoordinator();
    const e = await t.admin("POST", "/api/enrollments", { kind: "device" });
    t.clock.advance(10 * 60_000 + 1000);
    const r = await t.api("POST", "/api/enroll", {
      body: { token: e.body.token, name: "late", kind: "terminal" },
    });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("enrollment_expired");
  });

  it("host enrollments last 30 minutes and return the enroll command", async () => {
    t = await startCoordinator();
    const e = await t.admin("POST", "/api/hosts/enrollments");
    expect(e.body.command).toBe(
      `switchyard host enroll --coordinator ${t.c.config.publicUrl} --token ${e.body.token}`,
    );
    t.clock.advance(20 * 60_000);
    const r = await t.api("POST", "/api/hosts/enroll", {
      body: { token: e.body.token, name: "nuc", platform: "linux" },
    });
    expect(r.status).toBe(201);
    expect(r.body.hostId).toMatch(/^hst_/);
    // A host token cannot enroll a device.
    const e2 = await t.admin("POST", "/api/hosts/enrollments");
    const d = await t.api("POST", "/api/enroll", {
      body: { token: e2.body.token, name: "x", kind: "terminal" },
    });
    expect(d.status).toBe(403);
  });

  it("sets an HttpOnly SameSite=Strict cookie for browsers and withholds the credential", async () => {
    t = await startCoordinator();
    const e = await t.admin("POST", "/api/enrollments", { kind: "device" });
    const r = await t.api("POST", "/api/enroll", {
      body: { token: e.body.token, name: "phone", kind: "pwa" },
    });
    expect(r.status).toBe(201);
    expect(r.body.credential).toBe("");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sy_device=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure when the public URL is https", async () => {
    t = await startCoordinator({ publicUrl: "https://switchyard.example.com" });
    const e = await t.admin("POST", "/api/enrollments", { kind: "device" });
    const r = await t.api("POST", "/api/enroll", {
      body: { token: e.body.token, name: "phone", kind: "browser" },
    });
    expect(r.headers.get("set-cookie")).toMatch(/Secure/i);
  });
});

describe("request authentication", () => {
  it("rejects unauthenticated API calls", async () => {
    t = await startCoordinator();
    const r = await t.api("GET", "/api/devices");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    const health = await t.api("GET", "/healthz");
    expect(health.body).toEqual({ ok: true });
  });

  it("authenticates percent-encoded paths that route to API endpoints", async () => {
    t = await startCoordinator();
    for (const path of [
      "/%61pi/sessions",
      "/%61pi/devices",
      "/a%70i/hosts",
      "/api%2Fsessions",
      "/api/%73essions",
      "/%61dapter-frames/some-adapter",
      "/%77s/client",
    ]) {
      const r = await t.api("GET", path);
      expect(r.status, path).toBe(401);
    }
    // The encoded path really reaches the API route: the admin token gets data, not a 404.
    const ok = await t.admin("GET", "/%61pi/devices");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
  });

  it("denies routes outside the public allowlist by default, whatever their prefix", async () => {
    t = await startCoordinator({
      plugins: [
        (c) => {
          c.app.get("/internal/secret", async () => ({ secret: true }));
        },
      ],
    });
    expect((await t.api("GET", "/internal/secret")).status).toBe(401);
    expect((await t.api("GET", "/%69nternal/secret")).status).toBe(401);
    expect((await t.admin("GET", "/internal/secret")).body).toEqual({ secret: true });
  });

  it("rejects mutations through percent-encoded paths without credentials or CSRF proof", async () => {
    t = await startCoordinator();
    for (const path of ["/%61pi/enrollments", "/%61pi/hosts/enrollments", "/api%2Fenrollments"]) {
      const r = await t.api("POST", path, { body: { kind: "device" } });
      expect(r.status, path).toBe(401);
    }
    const { cookie } = await enrollDevice(t, "browser");
    const noHeader = await t.api("POST", "/%61pi/enrollments", {
      cookie: cookie!,
      body: { kind: "device" },
      headers: { origin: "https://evil.example" },
    });
    expect(noHeader.status).toBe(403);
    // Public routes stay public, encoded or not.
    const enroll = await t.api("POST", "/%61pi/enroll", {
      body: { token: "nope", name: "x", kind: "terminal" },
    });
    expect(enroll.status).toBe(401);
    expect(enroll.body.error.message).toMatch(/enrollment token/);
    expect((await t.api("GET", "/%68ealthz")).body).toEqual({ ok: true });
  });

  it("accepts the admin.token as the implicit local admin device", async () => {
    t = await startCoordinator();
    const me = await t.admin("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.admin).toBe(true);
    expect(me.body.device.kind).toBe("cli");
    const devices = await t.admin("GET", "/api/devices");
    expect(devices.body).toEqual([]);
  });

  it("enforces CSRF rules for cookie-authenticated mutations", async () => {
    t = await startCoordinator();
    const { cookie } = await enrollDevice(t, "browser");
    const origin = t.c.config.publicUrl;
    // GET with cookie only is fine.
    expect((await t.api("GET", "/api/devices", { cookie: cookie! })).status).toBe(200);
    // Missing header.
    const noHeader = await t.api("POST", "/api/enrollments", {
      cookie: cookie!,
      body: { kind: "device" },
      headers: { origin },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe("forbidden");
    // Untrusted origin.
    const badOrigin = await t.api("POST", "/api/enrollments", {
      cookie: cookie!,
      body: { kind: "device" },
      headers: { origin: "https://evil.example", "x-switchyard-request": "1" },
    });
    expect(badOrigin.status).toBe(403);
    // Missing origin.
    const noOrigin = await t.api("POST", "/api/enrollments", {
      cookie: cookie!,
      body: { kind: "device" },
      headers: { "x-switchyard-request": "1" },
    });
    expect(noOrigin.status).toBe(403);
    // Both present.
    const ok = await t.api("POST", "/api/enrollments", {
      cookie: cookie!,
      body: { kind: "device" },
      headers: { origin, "x-switchyard-request": "1" },
    });
    expect(ok.status).toBe(201);
  });

  it("rejects cookie WebSockets from untrusted origins", async () => {
    t = await startCoordinator();
    const { cookie } = await enrollDevice(t, "browser");
    await expect(
      FakeClient.connect(t, { cookie: cookie!, origin: "https://evil.example" }),
    ).rejects.toThrow(/403/);
    const ok = await FakeClient.connect(t, { cookie: cookie!, origin: t.c.config.publicUrl });
    ok.close();
  });
});

describe("revocation", () => {
  it("revoked devices get 401 device_revoked and their sockets get force_logout", async () => {
    t = await startCoordinator();
    const dev = await enrollDevice(t, "terminal");
    const client = await FakeClient.connect(t, { token: dev.credential });
    await client.hello(null);

    const r = await t.admin("POST", `/api/devices/${dev.deviceId}/revoke`);
    expect(r.status).toBe(200);
    expect(r.body.revokedAt).not.toBeNull();

    const logout = await client.inbox.waitFor((m) => m.type === "force_logout");
    expect(logout).toMatchObject({ type: "force_logout" });
    await until(() => client.closeCode !== null);

    const after = await t.api("GET", "/api/me", { token: dev.credential });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("device_revoked");
    await expect(FakeClient.connect(t, { token: dev.credential })).rejects.toThrow(/401/);
  });

  it("refuses to revoke the local admin device", async () => {
    t = await startCoordinator();
    const r = await t.admin("POST", "/api/devices/dev_localadmin/revoke");
    expect(r.status).toBe(403);
  });

  it("sets preferredMobile exclusively", async () => {
    t = await startCoordinator();
    const a = await enrollDevice(t, "pwa", "a");
    const b = await enrollDevice(t, "pwa", "b");
    await t.admin("PATCH", `/api/devices/${a.deviceId}`, { preferredMobile: true });
    await t.admin("PATCH", `/api/devices/${b.deviceId}`, { preferredMobile: true });
    const list = (await t.admin("GET", "/api/devices")).body as {
      id: string;
      preferredMobile: boolean;
    }[];
    expect(list.find((d) => d.id === a.deviceId)!.preferredMobile).toBe(false);
    expect(list.find((d) => d.id === b.deviceId)!.preferredMobile).toBe(true);
  });
});
