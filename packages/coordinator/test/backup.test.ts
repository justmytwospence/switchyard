// @module-tag slow
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backup, LATEST_MIGRATION, restore } from "../src/index.js";
import { startCoordinator, type TestCoordinator, tempDir } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe("backup and restore", () => {
  it("backs up online, refuses restore while running, restores after stop", async () => {
    t = await startCoordinator();
    await t.admin("POST", "/api/profiles", { name: "Before backup" });
    const out = join(tempDir("sy-bak-"), "coordinator-backup.db");
    const b = backup(t.dir, out);
    expect(b.migrationLevel).toBe(LATEST_MIGRATION);
    expect(existsSync(out)).toBe(true);
    expect(() => backup(t!.dir, out)).toThrow(/already exists/);

    await t.admin("POST", "/api/profiles", { name: "After backup" });
    expect(() => restore(t!.dir, out)).toThrow(/running/);

    const dir = t.dir;
    await t.stop();
    const r = restore(dir, out);
    expect(r.previous).toMatch(/coordinator\.db\.bak-/);
    expect(readdirSync(dir).some((f) => f.startsWith("coordinator.db.bak-"))).toBe(true);

    t = await startCoordinator({ dir });
    const names = (await t.admin("GET", "/api/profiles")).body.map((p: { name: string }) => p.name);
    expect(names).toContain("Before backup");
    expect(names).not.toContain("After backup");
  });

  it("keeps the last known project bindings in a backup without including connector keys", async () => {
    t = await startCoordinator();
    const db = t.c.store.db;
    const id = "cat_backup";
    db.prepare("INSERT INTO catalog_connections VALUES (?,?,?,?)").run(
      id,
      "github.com",
      "acme",
      JSON.stringify({
        id,
        authority: "github.com",
        account: "acme",
        accountType: "organization",
        state: "ready",
        lastSyncedAt: "2026-11-28T00:00:00.000Z",
        lastError: null,
        installUrl: null,
        manageUrl: null,
      }),
    );
    db.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(
      "prj_backup",
      "https://github.com/acme/a",
      JSON.stringify({
        id: "prj_backup",
        catalog: { state: "listed", authority: "github.com", externalId: "1", fullName: "acme/a" },
      }),
      "now",
      "now",
    );
    db.prepare("INSERT INTO catalog_bindings VALUES (?,?,?)").run("github.com", "1", "prj_backup");
    const out = join(t.dir, "catalog.db");
    backup(t.dir, out);
    const saved = new DatabaseSync(out);
    try {
      expect(saved.prepare("SELECT project_id FROM catalog_bindings").get()).toEqual({
        project_id: "prj_backup",
      });
      expect(
        saved
          .prepare("SELECT json_extract(json,'$.lastSyncedAt') AS synced FROM catalog_connections")
          .get(),
      ).toEqual({ synced: "2026-11-28T00:00:00.000Z" });
      expect(
        saved
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'catalog_%'")
          .all()
          .map((r) => r.name)
          .sort(),
      ).toEqual([
        "catalog_bindings",
        "catalog_conflicts",
        "catalog_connections",
        "catalog_memberships",
      ]);
    } finally {
      saved.close();
    }
  });

  it("refuses backups from a newer schema", async () => {
    t = await startCoordinator();
    const out = join(tempDir("sy-bak-"), "newer.db");
    backup(t.dir, out);
    const db = new DatabaseSync(out);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', '')",
    ).run();
    db.close();
    const dir = t.dir;
    await t.stop();
    expect(() => restore(dir, out)).toThrow(/newer/);
  });

  it("writes coordinator.lock while running and releases it on stop", async () => {
    t = await startCoordinator();
    expect(existsSync(join(t.dir, "coordinator.lock"))).toBe(true);
    await t.stop();
    expect(existsSync(join(t.dir, "coordinator.lock"))).toBe(false);
  });
});
