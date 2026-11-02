import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clockTime, init, login, pair, parseEnrollmentInput } from "../src/commands/auth.js";
import {
  authOptionsFromEnv,
  coordinatorOptions,
  localUrlFor,
  parseListen,
} from "../src/commands/coordinator.js";
import { hostEnroll } from "../src/commands/host.js";
import { DEV_ORIGINS, upOptions } from "../src/commands/up.js";
import { resolveConnection, writeClientConfig, writeEndpoint } from "../src/config.js";
import { defaultDataDir } from "../src/paths.js";
import { stubFetch, testCtx } from "./helpers.js";

describe("paths and options", () => {
  it("defaults the data dir per platform", () => {
    expect(defaultDataDir({}, "darwin", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/switchyard/coordinator",
    );
    expect(defaultDataDir({}, "linux", "/home/me")).toBe("/home/me/.local/share/switchyard");
    expect(defaultDataDir({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/switchyard");
    expect(defaultDataDir({ SWITCHYARD_DATA_DIR: "/data" }, "linux", "/home/me")).toBe("/data");
  });

  it("parses listen addresses", () => {
    expect(parseListen("0.0.0.0:7400")).toEqual({ host: "0.0.0.0", port: 7400 });
    expect(parseListen(":8080")).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(parseListen("9000")).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parseListen("[::1]:7400")).toEqual({ host: "::1", port: 7400 });
    expect(() => parseListen("x:99999")).toThrow(/Invalid listen/);
    expect(localUrlFor({ host: "0.0.0.0" }, 7400)).toBe("http://127.0.0.1:7400");
    expect(localUrlFor({ host: "::1" }, 7400)).toBe("http://[::1]:7400");
  });

  it("reads coordinator settings from flags, then SWITCHYARD_* env", () => {
    const env = {
      SWITCHYARD_DATA_DIR: "/data",
      SWITCHYARD_LISTEN: "127.0.0.1:9000",
      SWITCHYARD_PUBLIC_URL: "https://sy.example.com",
      SWITCHYARD_TRUSTED_ORIGINS: "https://sy.example.com, https://alt.example.com/",
      SWITCHYARD_WEB_DIST: "/web",
    };
    expect(coordinatorOptions({}, env)).toEqual({
      dataDir: "/data",
      listen: { host: "127.0.0.1", port: 9000 },
      publicUrl: "https://sy.example.com",
      trustedOrigins: ["https://sy.example.com", "https://alt.example.com"],
      webDist: "/web",
    });
    expect(coordinatorOptions({ dataDir: "/other", listen: ":1" }, env)).toMatchObject({
      dataDir: "/other",
      listen: { host: "0.0.0.0", port: 1 },
    });
    expect(() => coordinatorOptions({ publicUrl: "sy.example.com" }, {})).toThrow(/http/);
  });

  it("reads the host secret, trusted proxies and OIDC from env", () => {
    expect(authOptionsFromEnv({})).toEqual({});
    const env = {
      SWITCHYARD_HOST_ENROLL_SECRET: "s".repeat(40),
      SWITCHYARD_TRUSTED_PROXIES: "172.18.0.0/16, 10.0.0.2",
      SWITCHYARD_OIDC_ISSUER: "https://auth.example.com",
      SWITCHYARD_OIDC_CLIENT_ID: "switchyard",
      SWITCHYARD_OIDC_CLIENT_SECRET: "cs",
      SWITCHYARD_OIDC_OWNER_EMAIL: "me@example.com",
    };
    expect(coordinatorOptions({}, { ...env, SWITCHYARD_DATA_DIR: "/data" })).toMatchObject({
      hostEnrollSecret: "s".repeat(40),
      trustedProxies: ["172.18.0.0/16", "10.0.0.2"],
      oidc: {
        issuer: "https://auth.example.com",
        clientId: "switchyard",
        clientSecret: "cs",
        label: "Sign in with single sign-on",
        scopes: "openid profile email groups",
        owner: { subject: null, email: "me@example.com", group: null },
      },
    });
    const custom = authOptionsFromEnv({
      SWITCHYARD_OIDC_ISSUER: "https://auth.example.com",
      SWITCHYARD_OIDC_CLIENT_ID: "switchyard",
      SWITCHYARD_OIDC_LABEL: "Sign in with Authelia",
      SWITCHYARD_OIDC_SCOPES: "openid email",
      SWITCHYARD_OIDC_OWNER_SUBJECT: "abc",
      SWITCHYARD_OIDC_OWNER_GROUP: "admins",
    });
    expect(custom.oidc).toEqual({
      issuer: "https://auth.example.com",
      clientId: "switchyard",
      clientSecret: null,
      label: "Sign in with Authelia",
      scopes: "openid email",
      owner: { subject: "abc", email: null, group: "admins" },
    });
    expect(() => authOptionsFromEnv({ SWITCHYARD_OIDC_ISSUER: "https://a" })).toThrow(
      /SWITCHYARD_OIDC_CLIENT_ID/,
    );
  });

  it("standalone defaults to a localhost public URL (passkeys need a name) and trusts 127.0.0.1 too", () => {
    const o = upOptions({ port: "7499", dataDir: "/d", webDist: "/w" }, {});
    expect(o.publicUrl).toBe("http://localhost:7499");
    expect(o.listen).toEqual({ host: "0.0.0.0", port: 7499 });
    expect(o.trustedOrigins).toEqual(["http://localhost:7499", "http://127.0.0.1:7499"]);
    const dev = upOptions({ dataDir: "/d", publicUrl: "http://192.168.1.5:7400", dev: true }, {});
    expect(dev.trustedOrigins).toEqual(["http://192.168.1.5:7400", ...DEV_ORIGINS]);
  });
});

describe("credentials", () => {
  it("resolves flags, then env, then client.json, then the local admin token", () => {
    const ctx = testCtx(fetch);
    const paths = ctx.paths!;
    expect(() => resolveConnection({}, {}, paths)).toThrow(/Not signed in/);
    mkdirSync(paths.dataDir!, { recursive: true });
    writeFileSync(join(paths.dataDir!, "admin.token"), "admintok\n");
    writeEndpoint(paths.dataDir!, { localUrl: "http://127.0.0.1:7499", publicUrl: "x" });
    expect(resolveConnection({}, {}, paths)).toEqual({
      url: "http://127.0.0.1:7499",
      credential: "admintok",
      source: "admin.token",
    });
    writeClientConfig(paths.clientConfig!, {
      coordinatorUrl: "https://sy/",
      credential: "devcred",
    });
    expect(resolveConnection({}, {}, paths)).toMatchObject({
      url: "https://sy",
      credential: "devcred",
      source: "client.json",
    });
    expect(
      resolveConnection({}, { SWITCHYARD_URL: "https://env", SWITCHYARD_TOKEN: "envtok" }, paths),
    ).toMatchObject({ url: "https://env", credential: "envtok", source: "env" });
    expect(resolveConnection({ coordinator: "https://f", token: "ftok" }, {}, paths)).toMatchObject(
      {
        url: "https://f",
        credential: "ftok",
        source: "flags",
      },
    );
  });

  it("login enrolls as a terminal and writes client.json with mode 0600", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/enroll": () => ({
        status: 201,
        body: { deviceId: "dev_1", credential: "secret" },
      }),
    });
    const ctx = testCtx(fetch);
    const { path } = await login(ctx, {
      token: "https://sy.example.com/enroll#token=abc",
      name: "laptop terminal",
    });
    expect(calls[0]).toMatchObject({
      path: "/api/enroll",
      body: { token: "abc", name: "laptop terminal", kind: "terminal" },
      auth: null,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      coordinatorUrl: "https://sy.example.com",
      credential: "secret",
      deviceId: "dev_1",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("parses enrollment input", () => {
    expect(parseEnrollmentInput("tok", "http://c/")).toEqual({ url: "http://c", token: "tok" });
    expect(() => parseEnrollmentInput("tok", undefined)).toThrow(/--coordinator/);
    expect(parseEnrollmentInput("http://c:7400/enroll#token=t1&kind=host", undefined)).toEqual({
      url: "http://c:7400",
      token: "t1",
    });
  });

  it("pair creates a device enrollment with the admin token and prints a QR", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/enrollments": (c) => ({
        status: 201,
        body: {
          token: "t1",
          url: "http://127.0.0.1:7400/enroll#token=t1",
          expiresAt: "2026-11-02T10:10:00.000Z",
          qrSvg: "<svg/>",
          command:
            (c.body as { kind: string }).kind === "host" ? "switchyard host enroll ..." : null,
        },
      }),
    });
    const ctx = testCtx(fetch, { SWITCHYARD_ADMIN_TOKEN: "admintok" });
    await pair(ctx, {});
    expect(calls[0]).toMatchObject({
      path: "/api/enrollments",
      body: { kind: "device" },
      auth: "Bearer admintok",
    });
    expect(ctx.lines).toContain("  http://127.0.0.1:7400/enroll#token=t1");
    expect(ctx.lines.some((l) => l.includes("▄") || l.includes("█"))).toBe(true);
    const host = testCtx(fetch, { SWITCHYARD_ADMIN_TOKEN: "admintok" });
    await pair(host, { host: true });
    expect(calls[1]?.body).toEqual({ kind: "host" });
    expect(host.lines).toContain("  switchyard host enroll ...");
  });

  it("init sets the server up and prints the first link with a QR", async () => {
    const enrollment = {
      token: "t1",
      url: "http://localhost:7400/enroll#token=t1",
      expiresAt: "2026-11-02T10:10:00.000Z",
      qrSvg: "<svg/>",
      command: null,
    };
    let already = false;
    const { fetch, calls } = stubFetch({
      "POST /api/admin/init": () => {
        const r = { alreadyInitialized: already, enrollment };
        already = true;
        return r;
      },
    });
    const ctx = testCtx(fetch, { SWITCHYARD_ADMIN_TOKEN: "admintok" });
    const first = await init(ctx, {});
    expect(first.alreadyInitialized).toBe(false);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/admin/init",
      auth: "Bearer admintok",
    });
    expect(ctx.lines[0]).toBe(
      `Switchyard is set up. Open this single-use link on your first device (expires ${clockTime(enrollment.expiresAt)}):`,
    );
    expect(ctx.lines).toContain("  http://localhost:7400/enroll#token=t1");
    expect(ctx.lines.some((l) => l.includes("▄") || l.includes("█"))).toBe(true);
    expect(ctx.lines.at(-1)).toBe(
      "Then add a passkey in Settings › Sign-in so other devices can sign in without a link.",
    );

    const again = testCtx(fetch, { SWITCHYARD_ADMIN_TOKEN: "admintok" });
    await init(again, {});
    expect(again.lines[0]).toBe("Already set up. New single-use sign-in link for one device:");
    expect(again.lines).toContain("  http://localhost:7400/enroll#token=t1");
    expect(again.lines.some((l) => l.includes("passkey"))).toBe(false);
    expect(clockTime("2026-11-02T10:10:00.000Z")).toMatch(/^\d\d:\d\d$/);
  });

  it("init needs the admin token", async () => {
    await expect(init(testCtx(fetch), {})).rejects.toThrow(/No admin token/);
  });

  it("host enroll takes exactly one of --token or --secret", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/hosts/enroll": () => ({ status: 201, body: { hostId: "hst_1", credential: "c" } }),
    });
    const ctx = testCtx(fetch);
    const config = join(ctx.dir, "host.json");
    await hostEnroll(ctx, {
      coordinator: "http://coord:7400",
      secret: "s".repeat(40),
      name: "nuc",
      config,
    });
    expect(calls[0]).toMatchObject({
      path: "/api/hosts/enroll",
      body: { secret: "s".repeat(40), name: "nuc" },
    });
    expect(calls[0]?.body).not.toHaveProperty("token");
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({ hostId: "hst_1" });
    await expect(
      hostEnroll(ctx, { coordinator: "http://coord", name: "x", config }),
    ).rejects.toThrow(/exactly one of --token or --secret/);
    await expect(
      hostEnroll(ctx, { coordinator: "http://coord", token: "t", secret: "s", name: "x", config }),
    ).rejects.toThrow(/exactly one of --token or --secret/);
  });

  it("pair refuses without an admin token", async () => {
    const ctx = testCtx(fetch);
    await expect(pair(ctx, {})).rejects.toThrow(/No admin token/);
  });
});
