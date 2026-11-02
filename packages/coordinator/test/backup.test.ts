import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backup, restore } from "../src/index.js";
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
    expect(b.migrationLevel).toBe(1);
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
