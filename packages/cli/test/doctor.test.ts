import { describe, expect, it } from "vitest";
import { type DoctorDeps, printDoctor, runDoctor } from "../src/commands/doctor.js";
import { stubFetch, testCtx } from "./helpers.js";

const okPi = {
  version: "1.4.0",
  compatible: true,
  capabilities: {} as never,
  reason: null,
};

function deps(over: Partial<DoctorDeps> = {}, hostJson: string | null = null): DoctorDeps {
  return {
    nodeVersion: "26.13.0",
    detectPi: async () => okPi,
    gitVersion: async () => "git version 2.56.0",
    hostConfigPaths: ["/h/host.json"],
    readFile: (p) => (p === "/h/host.json" ? hostJson : null),
    ...over,
  };
}

const HOST = JSON.stringify({
  coordinatorUrl: "http://coord",
  hostId: "hst_1",
  credential: "x",
  name: "mac",
});

function healthy(over: Record<string, (c: unknown) => unknown> = {}) {
  return stubFetch({
    "GET /healthz": () => ({ ok: true }),
    "GET /api/setup": () => ({
      passkey: { available: true, registered: true, reason: null },
      oidc: { label: "Sign in with SSO" },
    }),
    "GET /api/me": () => ({
      device: { id: "dev_1", name: "term", kind: "terminal" },
      admin: false,
    }),
    "GET /api/hosts/hst_1": () => ({ connectivity: "connected", revokedAt: null }),
    "GET /api/diagnostics": () => ({ push: { vapidConfigured: true, subscriptions: 2 } }),
    ...over,
  });
}

const flags = { coordinator: "http://coord", token: "cred" };

describe("doctor", () => {
  it("passes every check on a healthy host", async () => {
    const { fetch } = healthy();
    const ctx = testCtx(fetch);
    const results = await runDoctor(ctx, deps({}, HOST), flags);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["Node.js", "PASS"],
      ["Pi", "PASS"],
      ["git", "PASS"],
      ["Coordinator", "PASS"],
      ["Sign-in", "PASS"],
      ["Client credential", "PASS"],
      ["Host link", "PASS"],
      ["Push", "PASS"],
    ]);
    expect(printDoctor(ctx, results)).toBe(0);
    expect(ctx.lines[0]).toBe("PASS  Node.js: v26.13.0 (>=24)");
    expect(results.find((r) => r.name === "Sign-in")?.detail).toBe(
      "passkey: registered, single sign-on: on (Sign in with SSO)",
    );
  });

  it("warns without single sign-on or a passkey", async () => {
    const { fetch } = healthy({
      "GET /api/setup": () => ({
        passkey: { available: false, registered: false, reason: "Passkeys need HTTPS" },
        oidc: null,
      }),
    });
    const results = await runDoctor(testCtx(fetch), deps({}, HOST), flags);
    expect(results.find((r) => r.name === "Sign-in")).toEqual({
      status: "WARN",
      name: "Sign-in",
      detail:
        "no single sign-on and no passkey: sign in with a link from `switchyard pair` on the server",
    });
  });

  it("fails old Node, out-of-range Pi and an unreachable coordinator", async () => {
    const ctx = testCtx(async () => {
      throw new Error("ECONNREFUSED");
    });
    const results = await runDoctor(
      ctx,
      deps(
        {
          nodeVersion: "22.1.0",
          detectPi: async () => ({
            ...okPi,
            version: "1.7.0",
            compatible: false,
            reason: "Pi 1.7.0 is outside the tested range >=1.4.0 <1.6.0",
          }),
        },
        HOST,
      ),
      flags,
    );
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName["Node.js"]?.status).toBe("FAIL");
    expect(byName.Pi).toMatchObject({ status: "FAIL", detail: expect.stringContaining("1.7.0") });
    expect(byName.Coordinator?.status).toBe("FAIL");
    expect(byName["Client credential"]?.status).toBe("WARN");
    expect(printDoctor(ctx, results)).toBe(1);
  });

  it("only warns about missing Pi and git when this machine is not a host", async () => {
    const { fetch } = healthy();
    const missing = {
      detectPi: async () => ({ ...okPi, version: null, compatible: false, reason: "pi not found" }),
      gitVersion: async () => null,
    };
    const client = await runDoctor(testCtx(fetch), deps(missing, null), flags);
    expect(client.filter((r) => r.name === "Pi" || r.name === "git").map((r) => r.status)).toEqual([
      "WARN",
      "WARN",
    ]);
    expect(client.find((r) => r.name === "Host link")?.status).toBe("WARN");
    const host = await runDoctor(testCtx(fetch), deps(missing, HOST), flags);
    expect(host.filter((r) => r.name === "Pi" || r.name === "git").map((r) => r.status)).toEqual([
      "FAIL",
      "FAIL",
    ]);
  });

  it("fails a rejected credential and warns about an offline host and missing push devices", async () => {
    const rejected = healthy({
      "GET /api/me": () => ({
        status: 401,
        body: { error: { code: "device_revoked", message: "This device was revoked" } },
      }),
    });
    const r1 = await runDoctor(testCtx(rejected.fetch), deps({}, HOST), flags);
    expect(r1.find((r) => r.name === "Client credential")).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("switchyard login"),
    });

    const offline = healthy({
      "GET /api/hosts/hst_1": () => ({ connectivity: "unreachable", revokedAt: null }),
      "GET /api/diagnostics": () => ({ push: { vapidConfigured: true, subscriptions: 0 } }),
    });
    const r2 = await runDoctor(testCtx(offline.fetch), deps({}, HOST), flags);
    expect(r2.find((r) => r.name === "Host link")?.status).toBe("WARN");
    expect(r2.find((r) => r.name === "Push")?.status).toBe("WARN");
  });
});
