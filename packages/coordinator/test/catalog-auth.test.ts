// @module-tag slow
import { afterEach, expect, it } from "vitest";
import type { RepositoryProvider } from "../src/index.js";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

it("requires the existing device and CSRF boundary for catalog writes", async () => {
  const provider: RepositoryProvider = {
    authority: "github.com",
    async beginRegistration({ state }) {
      return { url: "https://github.com/settings/apps/new", fields: { state } };
    },
    async completeRegistration() {
      throw new Error("secret provider response");
    },
    async listRepositories() {
      return { state: "pending" };
    },
    async resolveRemote() {
      return null;
    },
    async issueCloneGrant() {
      throw new Error("not used");
    },
    async releaseGrant() {},
    async disconnect() {},
  };
  t = await startCoordinator({ repositoryProvider: provider });
  const url = "/api/catalog/connections";
  const account = { account: "example", accountType: "personal" };
  expect((await t.api("GET", url)).status).toBe(401);
  const cookie = `sy_device=${t.c.adminToken}`;
  expect((await t.api("POST", `${url}/begin`, { cookie, body: account })).status).toBe(403);
  const begin = await t.api("POST", `${url}/begin`, {
    cookie,
    body: account,
    headers: { Origin: t.c.config.publicUrl, "X-Switchyard-Request": "1" },
  });
  expect(begin.status).toBe(200);
  const rejected = await t.admin("POST", `${url}/complete`, {
    state: begin.body.fields.state,
    code: "secret-code",
  });
  expect(rejected.status).toBe(409);
  expect(JSON.stringify(rejected.body)).not.toContain("secret");
  expect((await t.admin("GET", url)).body.connections).toEqual([]);
});
