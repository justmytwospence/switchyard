// @module-tag slow
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubApp } from "../src/catalog/github-app.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-catalog-"));
  dirs.push(dir);
  const app = new GitHubApp(dir, (async (input, init) =>
    handler(new URL(String(input)), init ?? {})) as typeof fetch);
  return { dir, app };
}
const json = (value: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { headers });
const registration = {
  connectionId: "cat_123",
  account: "alice",
  accountType: "personal" as const,
  code: "secret-code",
};
const converted = {
  id: 5,
  pem: key,
  slug: "switchyard-test",
  owner: { id: 7, login: "alice", type: "User" },
};
const install = { id: 9, app_id: 5, account: { id: 7, type: "User" }, suspended_at: null };
const repo = (id: number) => ({
  id,
  owner: { login: "alice" },
  name: `repo${id}`,
  default_branch: "main",
});

describe("GitHub catalog worker", () => {
  it("registers a private read-only app and stores only verified credentials", async () => {
    const { app, dir } = await fixture(() => json(converted));
    const begin = await app.beginRegistration({
      ...registration,
      returnUrl: "https://switchyard.example/return",
      state: "state",
    });
    expect(begin.url).toContain("github.com/settings/apps/new?state=state");
    expect(JSON.parse(begin.fields.manifest)).toMatchObject({
      public: false,
      default_permissions: { contents: "read" },
      default_events: [],
    });
    await app.completeRegistration(registration);
    const file = join(dir, "catalog-secrets/cat_123/app.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "catalog-secrets/cat_123"))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, "utf8")).not.toContain("secret-code");
  });
  it("rejects an unexpected owner and missing restored secrets", async () => {
    const { app } = await fixture(() =>
      json({ ...converted, owner: { ...converted.owner, login: "bob" } }),
    );
    await expect(app.completeRegistration(registration)).rejects.toThrow("owner");
    await expect(app.listRepositories(registration.connectionId)).rejects.toThrow(
      "Reconnect provider",
    );
  });
  it("validates pagination and scopes clone grants to exactly one repository", async () => {
    const bodies: any[] = [];
    const { app } = await fixture((url, init) => {
      if (url.pathname.includes("conversions")) return json(converted);
      if (url.pathname === "/app/installations") return json([install]);
      if (url.pathname.endsWith("access_tokens")) {
        bodies.push(JSON.parse(String(init.body)));
        return json({
          token: "sentinel",
          expires_at: "2030-01-01T00:00:00Z",
          repositories: [{ id: 2 }],
          permissions: { contents: "read", metadata: "read" },
        });
      }
      if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
      if (url.searchParams.get("page") === "2")
        return json({ total_count: 2, repositories: [repo(2)] });
      return json(
        { total_count: 2, repositories: [repo(1)] },
        { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' },
      );
    });
    await app.completeRegistration(registration);
    const result = await app.listRepositories(registration.connectionId);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("unexpected state");
    expect(result.repositories.map((r) => r.externalId)).toEqual(["1", "2"]);
    await app.issueCloneGrant(registration.connectionId, result.repositories[1]);
    expect(bodies).toEqual([{}, { repository_ids: [2], permissions: { contents: "read" } }]);
  });
  it("distinguishes pending from verified removal only after a complete inventory", async () => {
    let state: "pending" | "installed" | "error" | "invalid" = "pending";
    const { app } = await fixture((url) => {
      if (url.pathname.includes("conversions")) return json(converted);
      if (url.pathname === "/app/installations") {
        if (state === "error") return new Response(null, { status: 403 });
        if (state === "invalid") return json([{}]);
        return json(state === "installed" ? [install] : []);
      }
      throw new Error("unexpected request");
    });
    await app.completeRegistration(registration);
    expect((await app.listRepositories(registration.connectionId)).state).toBe("pending");
    state = "installed";
    expect((await app.installationStatus(registration.connectionId)).state).toBe("ready");
    state = "error";
    await expect(app.listRepositories(registration.connectionId)).rejects.toThrow("403");
    state = "invalid";
    await expect(app.listRepositories(registration.connectionId)).rejects.toThrow("inventory");
    state = "pending";
    expect((await app.listRepositories(registration.connectionId)).state).toBe("removed");
  });
  it("rejects a token when GitHub did not confirm the exact read-only scope", async () => {
    let revoked = false;
    const { app } = await fixture((url) => {
      if (url.pathname.includes("conversions")) return json(converted);
      if (url.pathname === "/app/installations") return json([install]);
      if (url.pathname.endsWith("access_tokens"))
        return json({
          token: "sensitive",
          expires_at: "later",
          repositories: [{ id: 2 }, { id: 3 }],
          permissions: { contents: "write" },
        });
      if (url.pathname === "/installation/token") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected request");
    });
    await app.completeRegistration(registration);
    await expect(
      app.issueCloneGrant(registration.connectionId, {
        authority: "github.com",
        externalId: "2",
        owner: "alice",
        name: "repo2",
        webUrl: "https://github.com/alice/repo2",
        cloneUrl: "https://github.com/alice/repo2.git",
        defaultBranch: "main",
      }),
    ).rejects.toThrow("repository-scoped");
    expect(revoked).toBe(true);
  });
  it("does not treat suspended, incomplete or foreign pagination as an empty catalog", async () => {
    let suspended = true;
    const { app } = await fixture((url) => {
      if (url.pathname.includes("conversions")) return json(converted);
      if (url.pathname === "/app/installations")
        return json([{ ...install, suspended_at: suspended ? "now" : null }]);
      if (url.pathname.endsWith("access_tokens")) return json({ token: "x", expires_at: "later" });
      if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
      return json(
        { total_count: 2, repositories: [repo(1)] },
        { link: '<https://evil.example/page>; rel="next"' },
      );
    });
    await app.completeRegistration(registration);
    expect((await app.listRepositories(registration.connectionId)).state).toBe("suspended");
    suspended = false;
    await expect(app.listRepositories(registration.connectionId)).rejects.toThrow(
      "pagination origin",
    );
  });
});
