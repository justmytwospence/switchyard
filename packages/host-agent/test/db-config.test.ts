import { statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultStateDir,
  enroll,
  HostDb,
  hostSocketUrl,
  loadConfig,
  MIGRATIONS,
  openHostDb,
  saveConfig,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const dirs: { cleanup(): void }[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

describe("host db", () => {
  it("rewrites cancelled interactions in migration 002", () => {
    const db = new HostDb(":memory:");
    db.migrate(MIGRATIONS.filter((m) => m.name === "001_init"));
    db.run(
      "INSERT INTO interactions (id, session_id, revision, state, json) VALUES (?, ?, ?, ?, ?)",
      ["int_1", "ses_1", 1, "cancelled", '{"id":"int_1","state":"cancelled"}'],
    );
    expect(db.migrate()).toEqual(["002_interaction_canceled"]);
    const row = db.get<{ state: string; json: string }>(
      "SELECT state, json FROM interactions WHERE id = 'int_1'",
    );
    expect(row?.state).toBe("canceled");
    expect(JSON.parse(row!.json).state).toBe("canceled");
    db.close();
  });

  it("migrates once, in WAL mode, and records the level", () => {
    const d = tempDir();
    dirs.push(d);
    const db = openHostDb(join(d.path, "host.db"));
    expect(db.migrationLevel()).toBe("002_interaction_canceled");
    expect(db.migrate()).toEqual([]);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    for (const t of [
      "meta",
      "outbox",
      "receipts",
      "dispatches",
      "sessions",
      "interactions",
      "adapter_state",
      "panels",
    ]) {
      expect(
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [t]),
      ).toBeTruthy();
    }
    db.close();
  });

  it("tx() commits, rolls back on throw, joins nested calls and runs afterCommit hooks", () => {
    const db = new HostDb(":memory:");
    db.migrate();
    const ran: string[] = [];
    db.tx(() => {
      db.setMeta("a", "1");
      db.tx(() => db.setMeta("b", "2"));
      db.afterCommit(() => ran.push("committed"));
      expect(ran).toEqual([]);
    });
    expect(ran).toEqual(["committed"]);
    expect(() =>
      db.tx(() => {
        db.setMeta("c", "3");
        db.afterCommit(() => ran.push("never"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.getMeta("a")).toBe("1");
    expect(db.getMeta("b")).toBe("2");
    expect(db.getMeta("c")).toBeNull();
    expect(ran).toEqual(["committed"]);
    expect(() =>
      db.run(
        "INSERT INTO dispatches (dispatch_key, run_id, state, updated_at) VALUES ('k', 'r', 'bogus', 'x')",
      ),
    ).toThrow();
    db.close();
  });
});

describe("config", () => {
  it("resolves paths from env overrides", () => {
    expect(defaultConfigPath({ SWITCHYARD_HOST_CONFIG: "/x/host.json" })).toBe("/x/host.json");
    expect(defaultConfigPath({}, "/home/u")).toBe("/home/u/.config/switchyard/host.json");
    expect(defaultStateDir({ SWITCHYARD_STATE_DIR: "/s" })).toBe("/s");
    expect(defaultStateDir({}, "darwin", "/Users/u")).toBe(
      "/Users/u/Library/Application Support/switchyard",
    );
    expect(defaultStateDir({}, "linux", "/home/u")).toBe("/home/u/.local/state/switchyard");
    expect(hostSocketUrl("https://sy.example.com/")).toBe("wss://sy.example.com/ws/host");
    expect(hostSocketUrl("http://127.0.0.1:7400")).toBe("ws://127.0.0.1:7400/ws/host");
  });

  it("writes host.json with mode 0600 and reads it back", () => {
    const d = tempDir();
    dirs.push(d);
    const path = join(d.path, "cfg", "host.json");
    saveConfig(path, { coordinatorUrl: "http://c", hostId: "hst_1", credential: "s", name: "n" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)).toEqual({
      coordinatorUrl: "http://c",
      hostId: "hst_1",
      credential: "s",
      name: "n",
    });
    expect(() => loadConfig(join(d.path, "missing.json"))).toThrow(/enroll/);
  });

  it("enroll() redeems the token and writes host.json", async () => {
    const d = tempDir();
    dirs.push(d);
    let body: any = null;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        body = JSON.parse(raw);
        if (req.url !== "/api/hosts/enroll" || body.token !== "good") {
          res.writeHead(410, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "enrollment_used", message: "Token used" } }));
          return;
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostId: "hst_new", credential: "cred" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const configPath = join(d.path, "host.json");
      const cfg = await enroll({
        coordinatorUrl: `${url}/`,
        token: "good",
        name: "laptop",
        configPath,
      });
      expect(body).toMatchObject({ token: "good", name: "laptop" });
      expect(["darwin", "linux"]).toContain(body.platform);
      expect(cfg).toMatchObject({ hostId: "hst_new", credential: "cred", coordinatorUrl: url });
      expect(loadConfig(configPath).hostId).toBe("hst_new");
      await expect(
        enroll({ coordinatorUrl: url, token: "bad", name: "x", configPath }),
      ).rejects.toMatchObject({ code: "enrollment_used" });
    } finally {
      server.close();
    }
  });

  it("enroll() with the shared secret posts {secret, name, platform}", async () => {
    const d = tempDir();
    dirs.push(d);
    const seen: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ hostId: "hst_s", credential: "cred_s" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const configPath = join(d.path, "host.json");
    const cfg = await enroll({
      coordinatorUrl: "http://c.example/",
      secret: "s".repeat(40),
      name: "nuc",
      platform: "linux",
      configPath,
      fetch: fakeFetch,
    });
    expect(seen).toEqual([
      {
        url: "http://c.example/api/hosts/enroll",
        body: { secret: "s".repeat(40), name: "nuc", platform: "linux" },
      },
    ]);
    expect(cfg).toMatchObject({ hostId: "hst_s", coordinatorUrl: "http://c.example", name: "nuc" });
    expect(loadConfig(configPath).credential).toBe("cred_s");
  });

  it("enroll() needs exactly one of token or secret", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const base = { coordinatorUrl: "http://c", name: "x", fetch: fakeFetch };
    await expect(
      enroll({ ...base, token: "t", secret: "s" } as unknown as Parameters<typeof enroll>[0]),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      enroll({ ...base } as unknown as Parameters<typeof enroll>[0]),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(enroll({ ...base, token: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toBe(0);
  });
});
