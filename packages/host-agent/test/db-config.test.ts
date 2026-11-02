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
  openHostDb,
  saveConfig,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const dirs: { cleanup(): void }[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

describe("host db", () => {
  it("migrates once, in WAL mode, and records the level", () => {
    const d = tempDir();
    dirs.push(d);
    const db = openHostDb(join(d.path, "host.db"));
    expect(db.migrationLevel()).toBe("001_init");
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
});
