import { enroll } from "@switchyard/host-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Device, Integration, waitFor } from "./harness.js";

/** Spec §19: enrollment expiration, reuse, and revocation. */
describe("enrollment", { timeout: 60_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create({ withHost: false });
  });
  afterAll(async () => {
    await env?.dispose();
  });

  const redeem = (token: string, kind = "terminal") =>
    env.api("POST", "/api/enroll", { as: "anonymous", body: { token, name: "Late", kind } });

  it("an expired device token gives enrollment_expired", async () => {
    const e = await env.ok("POST", "/api/enrollments", { body: { kind: "device" } });
    env.clockOffsetMs += 10 * 60_000 + 1000;
    try {
      const r = await redeem(e.token);
      expect(r.status).toBe(410);
      expect(r.body.error.code).toBe("enrollment_expired");
    } finally {
      env.clockOffsetMs = 0;
    }
  });

  it("an expired host token gives enrollment_expired through the host agent's enroll()", async () => {
    const e = await env.ok("POST", "/api/hosts/enrollments");
    env.clockOffsetMs += 30 * 60_000 + 1000;
    try {
      await expect(
        enroll({
          coordinatorUrl: env.url,
          token: e.token,
          name: "late host",
          configPath: `${env.stateDir}/late-host.json`,
        }),
      ).rejects.toMatchObject({ code: "enrollment_expired" });
    } finally {
      env.clockOffsetMs = 0;
    }
  });

  it("reusing a token gives enrollment_used", async () => {
    const e = await env.ok("POST", "/api/enrollments", { body: { kind: "device" } });
    const first = await redeem(e.token);
    expect(first.status).toBe(201);
    const again = await redeem(e.token, "browser");
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("enrollment_used");

    const h = await env.ok("POST", "/api/hosts/enrollments");
    const one = await env.api("POST", "/api/hosts/enroll", {
      as: "anonymous",
      body: { token: h.token, name: "h1", platform: "darwin" },
    });
    expect(one.status).toBe(201);
    const two = await env.api("POST", "/api/hosts/enroll", {
      as: "anonymous",
      body: { token: h.token, name: "h2", platform: "darwin" },
    });
    expect(two.body.error.code).toBe("enrollment_used");
  });

  async function revokeCase(device: Device) {
    const ws = await env.connect(device);
    expect((await env.api("GET", "/api/me", { as: device })).status).toBe(200);
    const r = await env.api("POST", `/api/devices/${device.id}/revoke`);
    expect(r.status).toBe(200);
    expect(r.body.revokedAt).not.toBeNull();
    await waitFor(() => ws.closeCode !== null, "socket closed");
    const logout = ws.messages.find((m) => m.type === "force_logout");
    expect(logout).toMatchObject({ type: "force_logout" });
    expect(ws.closeCode).toBe(4401);
    const me = await env.api("GET", "/api/me", { as: device });
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("device_revoked");
    const write = await env.api("POST", "/api/enrollments", {
      as: device,
      body: { kind: "device" },
    });
    expect(write.status).toBe(401);
    expect(write.body.error.code).toBe("device_revoked");
    // A new socket is refused too.
    await expect(env.connect(device)).rejects.toThrow(/401/);
  }

  it("revoking a terminal device: force_logout on its socket and 401 device_revoked", async () => {
    await revokeCase(env.devices!.terminal);
  });

  it("revoking a browser device (cookie) behaves the same; other devices are unaffected", async () => {
    const other = await env.connect(env.devices!.mobile);
    await revokeCase(env.devices!.desktop);
    expect(other.closeCode).toBeNull();
    expect(other.messages.some((m) => m.type === "force_logout")).toBe(false);
    expect((await env.api("GET", "/api/me", { as: env.devices!.mobile })).status).toBe(200);
  });
});
