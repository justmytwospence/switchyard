import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_LOGIN_TTL_MS } from "../src/index.js";
import { enrollDevice, startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator;
afterEach(async () => {
  await t?.cleanup();
});

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

async function start(name = "laptop terminal") {
  const r = await t.api("POST", "/api/auth/terminal/start", { body: { name } });
  expect(r.status).toBe(201);
  return r.body as { userCode: string; pollToken: string; verifyUrl: string; intervalMs: number };
}

function claim(s: { userCode: string; pollToken: string }, pollToken = s.pollToken) {
  return t.api("POST", "/api/auth/terminal/claim", {
    body: { userCode: s.userCode, pollToken },
  });
}

async function browser() {
  const { cookie } = await enrollDevice(t, "browser");
  const headers = { origin: t.c.config.publicUrl, "x-switchyard-request": "1" };
  return { cookie: cookie!, headers };
}

describe("terminal login", () => {
  it("starts with a code and verify URL, pending until approved", async () => {
    t = await startCoordinator();
    const s = await start();
    expect(s.userCode).toMatch(CODE);
    expect(s.verifyUrl).toBe(`${t.c.config.publicUrl}/terminal-login?code=${s.userCode}`);
    expect(s.intervalMs).toBe(2000);
    expect((await claim(s)).body).toEqual({ status: "pending" });
  });

  it("a signed-in browser approves; the terminal claims a terminal device once", async () => {
    t = await startCoordinator();
    const s = await start("my terminal");
    const b = await browser();
    const path = `/api/auth/terminal/requests/${s.userCode}`;
    const pending = await t.api("GET", path, { cookie: b.cookie });
    expect(pending.body).toMatchObject({ status: "pending", name: "my terminal" });
    const ok = await t.api("POST", `${path}/approve`, { cookie: b.cookie, headers: b.headers });
    expect(ok.status).toBe(200);
    expect((await t.api("GET", path, { cookie: b.cookie })).body.status).toBe("approved");
    expect(t.c.store.devices.list("kind = 'terminal'")).toHaveLength(0);
    const stored = t.c.store.st
      .get("SELECT data FROM auth_flows WHERE kind = 'terminal_login'")
      .get() as {
      data: string;
    };
    expect(stored.data).not.toContain("credential");
    const done = await claim(s);
    expect(done.body.status).toBe("done");
    const devices = t.c.store.devices.list("kind = 'terminal'");
    expect(devices).toHaveLength(1);
    expect(devices[0]!.id).toBe(done.body.deviceId);
    const me = await t.api("GET", "/api/me", { token: done.body.credential });
    expect(me.body.device).toMatchObject({
      kind: "terminal",
      enrolledVia: "approval",
      name: "my terminal",
    });
    expect((await claim(s)).status).toBe(401);
  });

  it("an approved request that is never claimed creates no device", async () => {
    t = await startCoordinator();
    const s = await start();
    const b = await browser();
    const url = `/api/auth/terminal/requests/${s.userCode}/approve`;
    expect((await t.api("POST", url, { cookie: b.cookie, headers: b.headers })).status).toBe(200);
    t.clock.advance(TERMINAL_LOGIN_TTL_MS + 1);
    expect((await claim(s)).status).toBe(401);
    expect(t.c.store.devices.list("kind = 'terminal'")).toHaveLength(0);
  });

  it("deny ends the request", async () => {
    t = await startCoordinator();
    const s = await start();
    const b = await browser();
    const r = await t.api("POST", `/api/auth/terminal/requests/${s.userCode}/deny`, {
      cookie: b.cookie,
      headers: b.headers,
    });
    expect(r.status).toBe(200);
    expect((await claim(s)).body).toEqual({ status: "denied" });
    expect((await claim(s)).status).toBe(401);
  });

  it("needs a signed-in device to look up or approve, and the poll token to claim", async () => {
    t = await startCoordinator();
    const s = await start();
    expect((await t.api("GET", `/api/auth/terminal/requests/${s.userCode}`)).status).toBe(401);
    expect((await t.api("POST", `/api/auth/terminal/requests/${s.userCode}/approve`)).status).toBe(
      401,
    );
    expect((await claim(s, "wrong")).status).toBe(401);
    const b = await browser();
    const lower = s.userCode.toLowerCase().replace("-", "");
    const r = await t.api("GET", `/api/auth/terminal/requests/${lower}`, { cookie: b.cookie });
    expect(r.status).toBe(200);
    expect(r.body.userCode).toBe(s.userCode);
  });

  it("expires", async () => {
    t = await startCoordinator();
    const s = await start();
    const b = await browser();
    t.clock.advance(TERMINAL_LOGIN_TTL_MS + 1);
    expect((await claim(s)).status).toBe(401);
    const r = await t.api("GET", `/api/auth/terminal/requests/${s.userCode}`, {
      cookie: b.cookie,
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });

  it("rate limits start", async () => {
    t = await startCoordinator({ rateLimits: { auth: 1 } });
    expect((await t.api("POST", "/api/auth/terminal/start", { body: { name: "a" } })).status).toBe(
      201,
    );
    expect((await t.api("POST", "/api/auth/terminal/start", { body: { name: "a" } })).status).toBe(
      429,
    );
  });

  it("approving twice fails", async () => {
    t = await startCoordinator();
    const s = await start();
    const b = await browser();
    const url = `/api/auth/terminal/requests/${s.userCode}/approve`;
    expect((await t.api("POST", url, { cookie: b.cookie, headers: b.headers })).status).toBe(200);
    const again = await t.api("POST", url, { cookie: b.cookie, headers: b.headers });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_request");
  });
});
