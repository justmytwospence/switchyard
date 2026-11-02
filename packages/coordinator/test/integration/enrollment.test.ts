import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  enroll,
  type HostAgentHandle,
  runHostAgent,
  silentLogger,
  waitForConfig,
} from "@switchyard/host-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Device, Integration, sleep, tempDir, waitFor } from "./harness.js";

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

/** Hosts without host.json wait (and self-enroll with the shared secret) instead of exiting. */
describe("host self-enrollment and waiting", { timeout: 60_000 }, () => {
  const SECRET = "integration-shared-host-secret-0123456789";
  const FAST = { unreachableRetryMs: 50, errorRetryMs: 50, pollMs: 50, reminderMs: 60_000 };
  let env: Integration;
  const agents: HostAgentHandle[] = [];
  const dirs: string[] = [];
  beforeAll(async () => {
    env = await Integration.create({
      withHost: false,
      coordinator: { hostEnrollSecret: SECRET },
    });
  });
  afterEach(async () => {
    while (agents.length)
      await agents
        .pop()!
        .stop()
        .catch(() => {});
  });
  afterAll(async () => {
    await env?.dispose();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function dir(): string {
    const d = tempDir("sy-int-wait-");
    dirs.push(d);
    return d;
  }

  function startAgent(
    configPath: string,
    extraEnv: Record<string, string> = {},
  ): Promise<HostAgentHandle> {
    return runHostAgent({
      configPath,
      stateDir: dir(),
      // No Pi needed: the agent only has to connect.
      piBin: join(dir(), "no-pi"),
      env: extraEnv,
      ownerAdapterDir: dir(),
      handleSignals: false,
      backoffMs: [50, 100, 200],
      logger: silentLogger(),
      configWaitTiming: FAST,
    }).then((a) => {
      agents.push(a);
      return a;
    });
  }

  it("host self-enrolls with the shared secret through waitForConfig; a wrong secret is retried and never enrolls", async () => {
    const hostsBefore = env.c.store.hosts.list().length;

    // Wrong secret: logged and retried, never writes host.json or creates a host.
    const wrongPath = join(dir(), "wrong", "host.json");
    const warnings: string[] = [];
    const ctl = new AbortController();
    const wrong = waitForConfig({
      configPath: wrongPath,
      env: {
        SWITCHYARD_HOST_ENROLL_SECRET: "x".repeat(40),
        SWITCHYARD_COORDINATOR_URL: env.url,
      },
      log: {
        info: () => {},
        warn: (obj) => warnings.push(String((obj as { err?: string }).err)),
      },
      signal: ctl.signal,
      timing: FAST,
    });
    wrong.catch(() => {});
    await waitFor(() => warnings.length >= 2, "two failed attempts");
    ctl.abort(new Error("stop"));
    await expect(wrong).rejects.toThrow("stop");
    expect(warnings[0]).toBe("Wrong host enrollment secret");
    expect(existsSync(wrongPath)).toBe(false);
    expect(env.c.store.hosts.list()).toHaveLength(hostsBefore);

    // Right secret: the agent enrolls itself, writes host.json and connects.
    const configPath = join(dir(), "cfg", "host.json");
    const agent = await startAgent(configPath, {
      SWITCHYARD_HOST_ENROLL_SECRET: SECRET,
      SWITCHYARD_COORDINATOR_URL: env.url,
      SWITCHYARD_HOST_NAME: "Self-enrolled",
    });
    expect(existsSync(configPath)).toBe(true);
    expect(agent.config).toMatchObject({ name: "Self-enrolled", coordinatorUrl: env.url });
    await waitFor(
      () => env.c.hostHub.isConnected(agent.hostId) && agent.link.connected,
      "self-enrolled host connected",
    );
    expect(env.c.store.hosts.require(agent.hostId)).toMatchObject({
      name: "Self-enrolled",
      revokedAt: null,
    });
    expect(env.c.store.hosts.list()).toHaveLength(hostsBefore + 1);
  });

  it("a host started without config waits and connects once host.json appears", async () => {
    const configPath = join(dir(), "later", "host.json");
    let started: HostAgentHandle | null = null;
    const pending = startAgent(configPath).then((a) => {
      started = a;
      return a;
    });
    pending.catch(() => {});
    await sleep(300);
    expect(started).toBeNull();
    expect(existsSync(configPath)).toBe(false);

    const e = await env.ok("POST", "/api/hosts/enrollments");
    const cfg = await enroll({
      coordinatorUrl: env.url,
      token: e.token,
      name: "Late host",
      configPath,
    });
    const agent = await pending;
    expect(agent.hostId).toBe(cfg.hostId);
    await waitFor(
      () => env.c.hostHub.isConnected(agent.hostId) && agent.link.connected,
      "late host connected",
    );
  });
});
