import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.js";

export { MIGRATIONS, type Migration } from "./migrations.js";
export * from "./prune.js";

type Row = Record<string, SQLInputValue>;

/**
 * The host agent's SQLite database (`node:sqlite`, WAL). `DatabaseSync` has no transaction
 * helper, so `tx()` issues `BEGIN IMMEDIATE`/`COMMIT` itself; nested calls join the outer
 * transaction. `afterCommit()` callbacks run once the outermost transaction commits (and are
 * dropped on rollback); outside a transaction they run immediately.
 */
export class HostDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private depth = 0;
  private pendingAfterCommit: (() => void)[] = [];

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  /** Apply pending migrations in name order; returns the names applied now. */
  migrate(migrations: readonly Migration[] = MIGRATIONS): string[] {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const done = new Set(
      this.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name),
    );
    const applied: string[] = [];
    for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
      if (done.has(m.name)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [
          m.name,
          new Date().toISOString(),
        ]);
      });
      applied.push(m.name);
    }
    return applied;
  }

  /** Latest applied migration name, or null. */
  migrationLevel(): string | null {
    const r = this.get<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1",
    );
    return r?.name ?? null;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Run `fn` inside `BEGIN IMMEDIATE ... COMMIT` (joining an enclosing transaction). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        throw new Error("HostDb.tx() callbacks must be synchronous");
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.depth = 0;
      this.pendingAfterCommit = [];
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
    this.depth = 0;
    const callbacks = this.pendingAfterCommit;
    this.pendingAfterCommit = [];
    for (const cb of callbacks) cb();
    return result;
  }

  /** Run `fn` after the current transaction commits, or now when none is open. */
  afterCommit(fn: () => void): void {
    if (this.depth > 0) this.pendingAfterCommit.push(fn);
    else fn();
  }

  run(sql: string, params: SQLInputValue[] = []): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: SQLInputValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  // ---- meta ----

  getMeta(key: string): string | null {
    return (
      this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key])?.value ?? null
    );
  }

  setMeta(key: string, value: string): void {
    this.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  // ---- JSON row helpers ----

  getJson<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
    const r = this.get<{ json: string }>(sql, params);
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  allJson<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.all<{ json: string }>(sql, params).map((r) => JSON.parse(r.json) as T);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

/** Open (creating if needed) and migrate the host database. */
export function openHostDb(path: string): HostDb {
  const db = new HostDb(path);
  db.migrate();
  return db;
}
