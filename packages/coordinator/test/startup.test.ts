// @module-tag slow
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCoordinator,
  createLogger,
  dbPath,
  LATEST_MIGRATION,
  LOCK_FILE,
  migrate,
  openDb,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(dir: string) {
  dirs.push(dir);
  return {
    dataDir: dir,
    listen: { host: "127.0.0.1", port: 0 },
    logger: createLogger({ level: "silent" }),
    setupHint: false,
  };
}

describe("coordinator startup refusals", () => {
  it("refuses a data directory another live coordinator holds", () => {
    const dir = tempDir();
    // The parent (the test runner) is a live process that is not this one.
    writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
    expect(() => createCoordinator(options(dir))).toThrow(
      /Another coordinator \(pid \d+\) is using/,
    );
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it("refuses a database newer than this build and releases the lock", () => {
    const dir = tempDir();
    const db = openDb(dbPath(dir));
    migrate(db);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      LATEST_MIGRATION + 1,
      "future",
      new Date().toISOString(),
    );
    db.close();
    expect(() => createCoordinator(options(dir))).toThrow(
      /is newer than this coordinator supports/,
    );
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });
});
