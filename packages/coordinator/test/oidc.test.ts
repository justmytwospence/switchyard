import { type MockOidc, type MockOidcOptions, startMockOidc } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { OidcConfig } from "../src/index.js";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator | undefined;
let idp: MockOidc | undefined;
afterEach(async () => {
  await t?.cleanup();
  await idp?.close();
  t = undefined;
  idp = undefined;
});

const OWNER = {
  sub: "u-owner",
  email: "Owner@Example.com",
  email_verified: true,
  groups: ["admins"],
};

async function setup(
  owner: Partial<OidcConfig["owner"]>,
  mock: Partial<MockOidcOptions> = {},
): Promise<TestCoordinator> {
  idp = await startMockOidc({ claims: { ...OWNER, preferred_username: "owner" }, ...mock });
  t = await startCoordinator({
    oidc: {
      issuer: idp.issuer,
      clientId: "switchyard",
      clientSecret: "client-secret",
      label: "Sign in with Mock",
      scopes: "openid profile email groups",
      owner: { subject: null, email: null, group: null, ...owner },
    },
  });
  return t;
}

/** Same request against the coordinator's loopback address (publicUrl uses localhost). */
function local(url: string): string {
  const u = new URL(url);
  return `${t!.c.localUrl}${u.pathname}${u.search}`;
}

async function begin(body: Record<string, unknown> = {}) {
  const r = await t!.api("POST", "/api/auth/oidc/begin", {
    body: { deviceName: "Laptop", kind: "browser", next: "/sessions", handoff: false, ...body },
  });
  expect(r.status).toBe(200);
  return r.body as { authorizeUrl: string; flowId: string | null; pollToken: string | null };
}

/** Follow the IdP's auto-approval and call the coordinator callback. */
async function complete(authorizeUrl: string): Promise<Response> {
  const a = await fetch(authorizeUrl, { redirect: "manual" });
  expect(a.status).toBe(302);
  const callback = a.headers.get("location")!;
  expect(callback.startsWith(`${t!.c.config.publicUrl}/api/auth/oidc/callback?`)).toBe(true);
  return fetch(local(callback), { redirect: "manual" });
}

function errorOf(res: Response) {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!, "http://x");
  expect(loc.pathname).toBe("/sign-in");
  return { error: loc.searchParams.get("error"), detail: loc.searchParams.get("detail") ?? "" };
}

describe("OIDC owner sign-in", () => {
  it("direct flow: claims only in userinfo match, the cookie is set and it redirects to next", async () => {
    await setup({ email: "owner@example.com" });
    const b = await begin();
    expect(b.flowId).toBeNull();
    expect(b.pollToken).toBeNull();
    const authorize = new URL(b.authorizeUrl);
    expect(authorize.origin).toBe(idp!.issuer);
    expect(authorize.searchParams.get("client_id")).toBe("switchyard");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid profile email groups");
    expect(authorize.searchParams.get("nonce")).toBeTruthy();

    const res = await complete(b.authorizeUrl);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sessions");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sy_device=/);
    const me = await t!.api("GET", "/api/me", { cookie: cookie.split(";")[0]! });
    expect(me.body.device).toMatchObject({ name: "Laptop", kind: "browser", enrolledVia: "oidc" });
    expect(idp!.tokenRequests[0]).toEqual({
      clientId: "switchyard",
      auth: "client_secret_basic",
      redirectUri: `${t!.c.config.publicUrl}/api/auth/oidc/callback`,
    });
    // The callback is single use.
    const replay = await fetch(local(res.url), { redirect: "manual" });
    expect(errorOf(replay).error).toBe("invalid_request");
  });

  it("refuses a different account with a readable forbidden error", async () => {
    await setup({ email: "someone-else@example.com" });
    const res = await complete((await begin()).authorizeUrl);
    expect(res.headers.get("set-cookie")).toBeNull();
    const e = errorOf(res);
    expect(e.error).toBe("forbidden");
    expect(e.detail).toBe(
      "Signed in as owner (subject u-owner), which is not this server's owner.",
    );
  });

  it("refuses an unverified email", async () => {
    await setup({ email: "owner@example.com" });
    idp!.setClaims({ ...OWNER, email_verified: false });
    const e = errorOf(await complete((await begin()).authorizeUrl));
    expect(e.error).toBe("forbidden");
    expect(e.detail).toMatch(/Signed in as Owner@Example.com/);
  });

  it("matches by group and by subject, requiring every configured criterion", async () => {
    await setup({ group: "admins", subject: "u-owner" });
    expect((await complete((await begin()).authorizeUrl)).headers.get("location")).toBe(
      "/sessions",
    );
    idp!.setClaims({ ...OWNER, groups: ["users"] });
    expect(errorOf(await complete((await begin()).authorizeUrl)).error).toBe("forbidden");
    idp!.setClaims({ ...OWNER, sub: "u-other" });
    expect(errorOf(await complete((await begin()).authorizeUrl)).error).toBe("forbidden");
  });

  it("ignores a userinfo failure when the ID token carries the claims", async () => {
    await setup({ email: "owner@example.com" }, { idTokenClaimsOnly: true, failUserinfo: true });
    const res = await complete((await begin()).authorizeUrl);
    expect(res.headers.get("location")).toBe("/sessions");
  });

  it("fails when the needed claims are only in a failing userinfo", async () => {
    await setup({ group: "admins" }, { failUserinfo: true });
    const e = errorOf(await complete((await begin()).authorizeUrl));
    expect(e.error).toBe("forbidden");
    expect(e.detail).toMatch(/profile/);
  });

  it("never redirects off-site: //evil and absolute next become /", async () => {
    await setup({ email: "owner@example.com" });
    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const res = await complete((await begin({ next })).authorizeUrl);
      expect(res.headers.get("location"), next).toBe("/");
    }
  });

  it("handoff flow: the callback shows a page, then the PWA claims its device once", async () => {
    await setup({ email: "owner@example.com" });
    const b = await begin({ kind: "pwa", handoff: true });
    expect(b.flowId).toBeTruthy();
    expect(b.pollToken).toBeTruthy();
    const claim = (pollToken: string) =>
      t!.api("POST", "/api/auth/oidc/claim", { body: { flowId: b.flowId, pollToken } });

    expect((await claim(b.pollToken!)).body).toEqual({ status: "pending" });
    const res = await complete(b.authorizeUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Signed in.");
    expect(html).toContain("Return to the Switchyard app to continue.");
    expect(html).not.toContain("<script");

    const wrong = await claim("not-the-token");
    expect(wrong.status).toBe(401);
    const done = await claim(b.pollToken!);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: "done", deviceId: expect.stringMatching(/^dev_/) });
    const cookie = done.headers.get("set-cookie")!;
    const me = await t!.api("GET", "/api/me", { cookie: cookie.split(";")[0]! });
    expect(me.body.device).toMatchObject({
      id: done.body.deviceId,
      kind: "pwa",
      enrolledVia: "oidc",
    });
    expect((await claim(b.pollToken!)).status).toBe(401);
  });

  it("expired flows cannot complete", async () => {
    await setup({ email: "owner@example.com" });
    const b = await begin();
    t!.clock.advance(10 * 60_000 + 1000);
    const e = errorOf(await complete(b.authorizeUrl));
    expect(e.error).toBe("invalid_request");
  });

  it("describes itself", async () => {
    await setup({ email: "owner@example.com", group: "admins" });
    expect((await t!.api("GET", "/api/setup")).body).toMatchObject({
      oidc: { label: "Sign in with Mock" },
    });
    const methods = await t!.admin("GET", "/api/auth/methods");
    expect(methods.body.oidc).toEqual({
      issuer: idp!.issuer,
      label: "Sign in with Mock",
      ownerMatch: "email owner@example.com and group admins",
      status: "ready",
      error: null,
    });
  });

  it("reports an unreachable provider as an error status", async () => {
    idp = await startMockOidc({ claims: OWNER });
    const issuer = idp.issuer;
    await idp.close();
    idp = undefined;
    t = await startCoordinator({
      oidc: {
        issuer,
        clientId: "switchyard",
        clientSecret: null,
        label: "SSO",
        scopes: "openid",
        owner: { subject: "u", email: null, group: null },
      },
    });
    const methods = await t.admin("GET", "/api/auth/methods");
    expect(methods.body.oidc.status).toBe("error");
    expect(methods.body.oidc.error).toMatch(/unavailable/);
    const b = await t.api("POST", "/api/auth/oidc/begin", {
      body: { deviceName: "x", kind: "browser" },
    });
    expect(b.status).toBe(503);
  });

  it("refuses to start without an owner match, and begin needs OIDC configured", async () => {
    await expect(
      startCoordinator({
        oidc: {
          issuer: "https://idp.example.com",
          clientId: "switchyard",
          clientSecret: null,
          label: "SSO",
          scopes: "openid",
          owner: { subject: null, email: null, group: null },
        },
      }),
    ).rejects.toThrow(/OIDC needs an owner match/);
    t = await startCoordinator();
    const r = await t.api("POST", "/api/auth/oidc/begin", {
      body: { deviceName: "x", kind: "browser" },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("Single sign-on is not configured on this server");
  });
});
