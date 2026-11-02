import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION, SwitchyardError } from "@switchyard/protocol";
import { LATEST_MIGRATION, migrationLevel } from "./db/index.js";

export const DB_FILE = "coordinator.db";
export const LOCK_FILE = "coordinator.lock";

export function dbPath(dataDir: string): string {
  return join(dataDir, DB_FILE);
}

export function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid named by `coordinator.lock` when that process is alive. */
export function lockHolder(dataDir: string): number | null {
  const p = lockPath(dataDir);
  if (!existsSync(p)) return null;
  const pid = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
  return pidAlive(pid) ? pid : null;
}

/** Write the pid lock; refuses when another live process holds it. */
export function acquireLock(dataDir: string): void {
  const holder = lockHolder(dataDir);
  if (holder !== null && holder !== process.pid) {
    throw new SwitchyardError(
      "conflict",
      `Another coordinator (pid ${holder}) is using ${dataDir}`,
    );
  }
  writeFileSync(lockPath(dataDir), `${process.pid}\n`);
}

export function releaseLock(dataDir: string): void {
  const p = lockPath(dataDir);
  if (!existsSync(p)) return;
  const pid = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
  if (pid === process.pid) rmSync(p, { force: true });
}

/** Consistent online backup with `VACUUM INTO`. Safe while the coordinator runs. */
export function backup(dataDir: string, outFile: string): { file: string; migrationLevel: number } {
  const src = dbPath(dataDir);
  if (!existsSync(src)) throw new SwitchyardError("not_found", `No database at ${src}`);
  const out = resolve(outFile);
  if (existsSync(out)) throw new SwitchyardError("conflict", `${out} already exists`);
  mkdirSync(dirname(out), { recursive: true });
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(out);
    return { file: out, migrationLevel: migrationLevel(db) };
  } finally {
    db.close();
  }
}

/**
 * Restore a backup into `dataDir`. Refuses while a live coordinator holds the lock, or when the
 * backup's schema is newer than this build. The previous database is kept as
 * `coordinator.db.bak-<timestamp>`.
 */
export function restore(
  dataDir: string,
  file: string,
): { restoredFrom: string; previous: string | null; migrationLevel: number } {
  const holder = lockHolder(dataDir);
  if (holder !== null) {
    throw new SwitchyardError(
      "conflict",
      `Coordinator (pid ${holder}) is running on ${dataDir}; stop it before restoring`,
    );
  }
  const src = resolve(file);
  if (!existsSync(src)) throw new SwitchyardError("not_found", `${src} does not exist`);
  let level: number;
  const check = new DatabaseSync(src, { readOnly: true });
  try {
    const ok = check.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ok.integrity_check !== "ok") {
      throw new SwitchyardError(
        "invalid_request",
        `Backup failed integrity check: ${ok.integrity_check}`,
      );
    }
    level = migrationLevel(check);
  } finally {
    check.close();
  }
  if (level === 0)
    throw new SwitchyardError("invalid_request", "Not a Switchyard coordinator backup");
  if (level > LATEST_MIGRATION) {
    throw new SwitchyardError(
      "conflict",
      `Backup schema ${level} is newer than this coordinator (${LATEST_MIGRATION}); upgrade first`,
    );
  }
  mkdirSync(dataDir, { recursive: true });
  const target = dbPath(dataDir);
  let previous: string | null = null;
  if (existsSync(target)) {
    previous = `${target}.bak-${new Date().toISOString().replaceAll(":", "-")}`;
    // Fold the WAL into the main file so the kept copy is complete.
    const old = new DatabaseSync(target);
    try {
      old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      old.close();
    }
    renameSync(target, previous);
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  copyFileSync(src, target);
  return { restoredFrom: src, previous, migrationLevel: level };
}

export const VERSIONS = {
  protocol: PROTOCOL_VERSION,
  node: process.versions.node,
  sqlite: process.versions.sqlite ?? "unknown",
};
