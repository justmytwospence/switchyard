import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HostConfig,
  loadConfig,
  saveConfig,
  waitForConfig,
  waitForConfigChange,
} from "../src/config.js";
import { tempDir } from "./helpers.js";

const FAST = { unreachableRetryMs: 20, errorRetryMs: 30, pollMs: 20, reminderMs: 60_000 };
const SECRET = "s".repeat(40);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function dir(): string {
  const d = tempDir();
  cleanups.push(d.cleanup);
  return d.path;
}

function recorder() {
  const lines: { level: "info" | "warn"; obj: object; msg: string }[] = [];
  return {
    lines,
    messages: () => lines.map((l) => l.msg),
    log: {
      info: (obj: object, msg = "") => lines.push({ level: "info", obj, msg }),
      warn: (obj: object, msg = "") => lines.push({ level: "warn", obj, msg }),
    },
  };
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A stub `POST /api/hosts/enroll`: accepts SECRET, answers 401 otherwise (or per `respond`). */
async function stubCoordinator(
  port = 0,
  respond?: (body: any, n: number) => { status: number; body: unknown },
): Promise<{ url: string; bodies: any[]; server: Server }> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const out =
        respond?.(body, bodies.length) ??
        (req.url === "/api/hosts/enroll" && body.secret === SECRET
          ? { status: 201, body: { hostId: "hst_auto", credential: "cred_auto" } }
          : {
              status: 401,
              body: { error: { code: "unauthorized", message: "Wrong host enrollment secret" } },
            });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, server };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const sample: HostConfig = {
  coordinatorUrl: "http://c.example",
  hostId: "hst_1",
  credential: "cred",
  name: "laptop",
};

describe("waitForConfig", () => {
  it("loads an existing host.json right away", async () => {
    const configPath = join(dir(), "host.json");
    saveConfig(configPath, sample);
    const rec = recorder();
    await expect(waitForConfig({ configPath, env: {}, log: rec.log })).resolves.toEqual(sample);
    expect(rec.lines).toEqual([]);
  });

  it("without a secret, logs the enroll command and resolves once host.json appears", async () => {
    const configPath = join(dir(), "cfg", "host.json");
    const rec = recorder();
    const waiting = waitForConfig({
      configPath,
      env: { SWITCHYARD_COORDINATOR_URL: "https://sy.example.com" },
      log: rec.log,
      timing: FAST,
    });
    await until(() => rec.lines.length > 0);
    expect(rec.messages()[0]).toBe(
      "This host is not enrolled. Create a host token in Settings › Hosts › Add host, then run: " +
        "switchyard host enroll --coordinator https://sy.example.com --token <token>",
    );
    // A half-written file is retried, not fatal.
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{");
    await until(() => rec.lines.some((l) => l.level === "warn"));
    saveConfig(configPath, sample);
    await expect(waiting).resolves.toEqual(sample);
    // The reminder is rate limited: one hint while waiting.
    expect(rec.messages().filter((m) => m.startsWith("This host is not enrolled"))).toHaveLength(1);
  });

  it("self-enrolls with the shared secret and writes host.json", async () => {
    const stub = await stubCoordinator();
    const configPath = join(dir(), "host.json");
    const rec = recorder();
    const config = await waitForConfig({
      configPath,
      env: {
        SWITCHYARD_HOST_ENROLL_SECRET: SECRET,
        SWITCHYARD_COORDINATOR_URL: stub.url,
        SWITCHYARD_HOST_NAME: "NUC",
      },
      log: rec.log,
      timing: FAST,
    });
    expect(stub.bodies).toEqual([{ secret: SECRET, name: "NUC", platform: expect.any(String) }]);
    expect(config).toEqual({
      coordinatorUrl: stub.url,
      hostId: "hst_auto",
      credential: "cred_auto",
      name: "NUC",
    });
    expect(loadConfig(configPath)).toEqual(config);
  });

  it("retries an unreachable coordinator until it comes up", async () => {
    const port = await freePort();
    const configPath = join(dir(), "host.json");
    const rec = recorder();
    const waiting = waitForConfig({
      configPath,
      env: {
        SWITCHYARD_HOST_ENROLL_SECRET: SECRET,
        SWITCHYARD_COORDINATOR_URL: `http://127.0.0.1:${port}`,
      },
      log: rec.log,
      timing: FAST,
    });
    await until(
      () =>
        rec.messages().filter((m) => m === "Coordinator not reachable yet; retrying").length >= 2,
    );
    const stub = await stubCoordinator(port);
    await expect(waiting).resolves.toMatchObject({ hostId: "hst_auto" });
    expect(stub.bodies).toHaveLength(1);
  });

  it("retries other enrollment errors on the slower schedule and never writes a config", async () => {
    const stub = await stubCoordinator(0, (_body, n) =>
      n < 3
        ? { status: 401, body: { error: { code: "unauthorized", message: "Wrong secret" } } }
        : { status: 201, body: { hostId: "hst_late", credential: "c" } },
    );
    const configPath = join(dir(), "host.json");
    const rec = recorder();
    const config = await waitForConfig({
      configPath,
      env: { SWITCHYARD_HOST_ENROLL_SECRET: SECRET, SWITCHYARD_COORDINATOR_URL: stub.url },
      log: rec.log,
      timing: FAST,
    });
    expect(config.hostId).toBe("hst_late");
    expect(stub.bodies).toHaveLength(3);
    const warns = rec.lines.filter((l) => l.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns[0]!.obj).toMatchObject({ err: "Wrong secret" });
  });

  it("stops waiting when the signal aborts", async () => {
    const configPath = join(dir(), "host.json");
    const ctl = new AbortController();
    const waiting = waitForConfig({
      configPath,
      env: {},
      log: recorder().log,
      signal: ctl.signal,
      timing: FAST,
    });
    setTimeout(() => ctl.abort(new Error("stop")), 30);
    await expect(waiting).rejects.toThrow("stop");
  });
});

describe("waitForConfigChange", () => {
  it("waitForConfigChange resolves on a new credential and ignores partial files", async () => {
    const configPath = join(dir(), "host.json");
    const a: HostConfig = {
      coordinatorUrl: "http://c",
      hostId: "hst_a",
      credential: "cred_a",
      name: "a",
    };
    saveConfig(configPath, a);
    const waiting = waitForConfigChange(configPath, a, { pollMs: 20 });
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(configPath, "{");
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false);
    const b = { ...a, credential: "cred_b" };
    saveConfig(configPath, b);
    await expect(waiting).resolves.toEqual(b);

    const ctl = new AbortController();
    const aborted = waitForConfigChange(configPath, b, { signal: ctl.signal, pollMs: 20 });
    setTimeout(() => ctl.abort(new Error("stop")), 30);
    await expect(aborted).rejects.toThrow("stop");
  });
});
