/**
 * Owner sign-in: the not-set-up screen, passkeys (Chromium virtual authenticator) and single
 * sign-on against the mock OpenID provider. Each test starts its own coordinator on a fresh
 * data dir with the public URL `http://localhost:<port>` (a passkey RP ID must be a domain name;
 * the shared e2e coordinator uses 127.0.0.1). Desktop project only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test";
import {
  type Coordinator,
  type CreateCoordinatorOptions,
  createCoordinator,
  createLogger,
} from "../../coordinator/dist/index.js";
import { type MockOidc, startMockOidc } from "../../test-fixtures/dist/index.js";

const webDist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");

interface LocalServer {
  coordinator: Coordinator;
  url: string;
  admin: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  close(): Promise<void>;
}

/** A coordinator serving the built web app on `http://localhost:<port>` with a fresh data dir. */
async function startLocal(over: Partial<CreateCoordinatorOptions> = {}): Promise<LocalServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "switchyard-e2e-signin-"));
  const coordinator = createCoordinator({
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    webDist,
    rateLimits: false,
    setupHint: false,
    logger: createLogger({ level: "silent" }),
    ...over,
  });
  await coordinator.start();
  const url = coordinator.config.publicUrl;
  expect(url).toBe(`http://localhost:${coordinator.port}`);
  return {
    coordinator,
    url,
    async admin(method, path, body) {
      const res = await fetch(`${coordinator.localUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${coordinator.adminToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
      return text ? JSON.parse(text) : null;
    },
    async close() {
      await coordinator.stop().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Enable WebAuthn on the page and attach a platform authenticator with user verification. */
async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { cdp, id: authenticatorId };
}

async function hasDeviceCookie(context: BrowserContext): Promise<boolean> {
  return (await context.cookies()).some((c) => c.name === "sy_device" && c.httpOnly);
}

/** Signed in: the app shell is up, /sign-in is gone and the coordinator knows this device. */
async function expectAuthenticated(page: Page, url: string): Promise<void> {
  await expect(page).not.toHaveURL((u) => u.pathname === "/sign-in");
  await expect(page.locator("#main")).toBeVisible();
  expect(await hasDeviceCookie(page.context())).toBe(true);
  const me = await page.request.get(`${url}/api/me`);
  expect(me.status()).toBe(200);
}

test.describe("owner sign-in", () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "desktop-1440x900", "desktop project only");
  });

  test("without single sign-on or a passkey, the page points to switchyard pair", async ({
    page,
  }) => {
    const server = await startLocal();
    try {
      await page.goto(`${server.url}/`);
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(page.getByTestId("signin-pair-hint")).toBeVisible();
      await expect(page.getByText("switchyard pair").first()).toBeVisible();
      await expect(page.getByTestId("signin-passkey")).toHaveCount(0);
      await expect(page.getByTestId("signin-oidc")).toHaveCount(0);
    } finally {
      await server.close();
    }
  });

  test("passkey: register in Settings › Sign-in, then sign in from a fresh browser", async ({
    page,
    browser,
  }) => {
    const server = await startLocal();
    let other: BrowserContext | undefined;
    try {
      // First device: the single-use link an admin sign-in link is.
      const init = await server.admin<{ url: string }>("POST", "/api/enrollments", {
        kind: "device",
      });
      expect(init.url.startsWith(`${server.url}/sign-in#token=`)).toBe(true);
      const first = await virtualAuthenticator(page);
      await page.goto(init.url);
      await page.getByTestId("signin-link").click();
      await expectAuthenticated(page, server.url);

      // Register a passkey.
      await page.goto(`${server.url}/settings/sign-in`);
      const section = page.getByTestId("settings-signin");
      await expect(section.getByText("No passkeys yet.")).toBeVisible();
      await section.getByTestId("passkey-add").click();
      const dialog = page.getByRole("dialog", { name: "Add a passkey" });
      await dialog.getByLabel("Passkey name").fill("Virtual key");
      await dialog.getByRole("button", { name: "Create passkey" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(section.getByTestId("passkey-row")).toHaveCount(1);
      await expect(section.getByTestId("passkey-row")).toContainText("Virtual key");

      const { credentials } = await first.cdp.send("WebAuthn.getCredentials", {
        authenticatorId: first.id,
      });
      expect(credentials).toHaveLength(1);
      expect(credentials[0]!.isResidentCredential).toBe(true);
      expect(credentials[0]!.rpId).toBe("localhost");

      // A fresh browser with the same passkey (as if synced to another device).
      other = await browser.newContext();
      const page2 = await other.newPage();
      const second = await virtualAuthenticator(page2);
      for (const credential of credentials) {
        await second.cdp.send("WebAuthn.addCredential", {
          authenticatorId: second.id,
          credential,
        });
      }
      await page2.goto(`${server.url}/`);
      await expect(page2).toHaveURL(/\/sign-in/);
      await expect(page2.getByText("Sign in to Switchyard")).toBeVisible();
      await page2.getByTestId("signin-passkey").click();
      await expectAuthenticated(page2, server.url);
      const me = await (await page2.request.get(`${server.url}/api/me`)).json();
      expect(me.device).toMatchObject({
        name: expect.stringMatching(/^Chrome on /),
        enrolledVia: "passkey",
      });
    } finally {
      await other?.close();
      await server.close();
    }
  });

  test("terminal login: a signed-in browser approves the code", async ({ page, browser }) => {
    const server = await startLocal();
    let other: BrowserContext | undefined;
    try {
      const link = await server.admin<{ url: string }>("POST", "/api/enrollments", {
        kind: "device",
      });
      await page.goto(link.url);
      await page.getByTestId("signin-link").click();
      await expectAuthenticated(page, server.url);

      const post = async (path: string, body: unknown) =>
        (
          await fetch(`${server.url}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json();
      const started = await post("/api/auth/terminal/start", { name: "e2e terminal" });
      const claimBody = { userCode: started.userCode, pollToken: started.pollToken };
      expect(await post("/api/auth/terminal/claim", claimBody)).toEqual({ status: "pending" });

      other = await browser.newContext();
      const page2 = await other.newPage();
      await page2.goto(started.verifyUrl);
      await expect(page2).toHaveURL(/\/sign-in\?next=%2Fterminal-login/);

      await page.goto(started.verifyUrl);
      await expect(page.getByTestId("terminal-login-code")).toHaveText(started.userCode);
      await expect(page.getByText("e2e terminal")).toBeVisible();
      await page.getByTestId("terminal-login-approve").click();
      await expect(page.getByText("Terminal signed in")).toBeVisible();

      const done = await post("/api/auth/terminal/claim", claimBody);
      expect(done.status).toBe("done");
      const me = await (
        await fetch(`${server.url}/api/me`, {
          headers: { authorization: `Bearer ${done.credential}` },
        })
      ).json();
      expect(me.device.kind).toBe("terminal");
    } finally {
      await other?.close();
      await server.close();
    }
  });

  test("single sign-on: the owner signs in; another account is refused", async ({
    page,
    browser,
  }) => {
    let idp: MockOidc | undefined;
    let server: LocalServer | undefined;
    let other: BrowserContext | undefined;
    try {
      // Email only in userinfo (the ID token carries just `sub`), as Authelia does.
      idp = await startMockOidc({
        claims: { sub: "u-owner", email: "Owner@Example.com", email_verified: true },
      });
      server = await startLocal({
        oidc: {
          issuer: idp.issuer,
          clientId: "switchyard",
          clientSecret: "client-secret",
          label: "Sign in with Mock SSO",
          scopes: "openid profile email groups",
          owner: { subject: null, email: "owner@example.com", group: null },
        },
      });

      // An OIDC owner sets the server up: sign-in is offered straight away.
      await page.goto(`${server.url}/settings/sign-in`);
      await expect(page).toHaveURL(/\/sign-in\?next=/);
      await expect(page.getByText("Sign in to Switchyard")).toBeVisible();
      await expect(page.getByTestId("signin-passkey")).toHaveCount(0);
      await page.getByTestId("signin-oidc").click();
      await expect(page).toHaveURL(`${server.url}/settings/sign-in`);
      await expectAuthenticated(page, server.url);
      const me = await (await page.request.get(`${server.url}/api/me`)).json();
      expect(me.device).toMatchObject({
        name: expect.stringMatching(/^Chrome on /),
        enrolledVia: "oidc",
      });
      await expect(page.getByTestId("settings-signin")).toContainText("Sign in with Mock SSO");

      // Someone else with an account at the same provider.
      idp.setClaims({ sub: "u-other", email: "someone@example.com", email_verified: true });
      other = await browser.newContext();
      const page2 = await other.newPage();
      await page2.goto(`${server.url}/sign-in`);
      await page2.getByTestId("signin-oidc").click();
      await expect(page2).toHaveURL(/\/sign-in/);
      const alert = page2.getByRole("alert");
      await expect(alert).toContainText("Signed in as");
      await expect(alert).toContainText("someone@example.com");
      await expect(alert).toContainText("which is not this server's owner");
      expect(await hasDeviceCookie(other)).toBe(false);
    } finally {
      await other?.close();
      await server?.close();
      await idp?.close();
    }
  });
});
