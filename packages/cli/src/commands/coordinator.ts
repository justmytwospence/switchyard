import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  backup,
  type CreateCoordinatorOptions,
  createCoordinator,
  dbPath,
  LATEST_MIGRATION,
  lockHolder,
  migrate,
  migrationLevel,
  openDb,
  restore,
} from "@switchyard/coordinator";
import { DEFAULT_PORT } from "@switchyard/protocol";
import { CliError, writeEndpoint } from "../config.js";
import type { Ctx } from "../context.js";
import { defaultDataDir, type Env, resolveWebDist } from "../paths.js";

export interface CoordinatorFlags {
  dataDir?: string;
  listen?: string;
  publicUrl?: string;
  trustedOrigins?: string;
  webDist?: string;
}

/** Parse `host:port`, `:port`, `port` or `[v6]:port`. */
export function parseListen(v: string): { host: string; port: number } {
  const s = v.trim();
  let host = "0.0.0.0";
  let portStr = s;
  const v6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) {
    host = v6[1]!;
    portStr = v6[2]!;
  } else if (s.includes(":")) {
    const i = s.lastIndexOf(":");
    host = s.slice(0, i) || "0.0.0.0";
    portStr = s.slice(i + 1);
  } else if (!/^\d+$/.test(s)) {
    host = s;
    portStr = String(DEFAULT_PORT);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`Invalid listen address "${v}" (expected host:port)`);
  }
  return { host, port };
}

export function parseOrigins(v: string | undefined): string[] | undefined {
  if (!v?.trim()) return undefined;
  return v
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Coordinator options from flags with env fallbacks (`SWITCHYARD_*`). */
export function coordinatorOptions(flags: CoordinatorFlags, env: Env): CreateCoordinatorOptions {
  const dataDir = flags.dataDir ? resolve(flags.dataDir) : defaultDataDir(env);
  const listen = parseListen(flags.listen ?? env.SWITCHYARD_LISTEN ?? `0.0.0.0:${DEFAULT_PORT}`);
  const publicUrl = (flags.publicUrl ?? env.SWITCHYARD_PUBLIC_URL)?.trim() || undefined;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    throw new CliError(`Public URL must start with http:// or https://, got "${publicUrl}"`);
  }
  const trustedOrigins = parseOrigins(flags.trustedOrigins ?? env.SWITCHYARD_TRUSTED_ORIGINS);
  return {
    dataDir,
    listen,
    publicUrl,
    trustedOrigins,
    webDist: resolveWebDist(flags.webDist, env),
  };
}

/** Resolve when SIGINT/SIGTERM arrives. */
export function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((res) => {
    const on = (sig: NodeJS.Signals) => {
      process.off("SIGINT", on);
      process.off("SIGTERM", on);
      res(sig);
    };
    process.on("SIGINT", on);
    process.on("SIGTERM", on);
  });
}

export async function coordinatorStart(ctx: Ctx, flags: CoordinatorFlags): Promise<void> {
  const opts = coordinatorOptions(flags, ctx.env);
  const c = createCoordinator(opts);
  await c.start();
  writeEndpoint(opts.dataDir, {
    localUrl: localUrlFor(opts.listen!, c.port),
    publicUrl: c.config.publicUrl,
  });
  ctx.err(
    `Switchyard coordinator listening on ${opts.listen!.host}:${c.port} (public URL ${c.config.publicUrl}; data ${opts.dataDir}${
      opts.webDist ? "" : "; web app not found, API only"
    })`,
  );
  const sig = await waitForSignal();
  ctx.err(`${sig}: stopping coordinator`);
  await c.stop();
}

/** A URL this machine can use to reach a coordinator bound to `listen`. */
export function localUrlFor(listen: { host?: string; port?: number }, port: number): string {
  const h = listen.host ?? "0.0.0.0";
  const host =
    h === "0.0.0.0" || h === "::" || h === "" ? "127.0.0.1" : h.includes(":") ? `[${h}]` : h;
  return `http://${host}:${port}`;
}

function dataDirOf(flags: { dataDir?: string }, env: Env): string {
  return flags.dataDir ? resolve(flags.dataDir) : defaultDataDir(env);
}

export function coordinatorBackup(ctx: Ctx, out: string, flags: { dataDir?: string }): void {
  const r = backup(dataDirOf(flags, ctx.env), out);
  ctx.out(`Backed up to ${r.file} (schema ${r.migrationLevel})`);
}

export function coordinatorRestore(ctx: Ctx, file: string, flags: { dataDir?: string }): void {
  const r = restore(dataDirOf(flags, ctx.env), file);
  ctx.out(`Restored ${r.restoredFrom} (schema ${r.migrationLevel}).`);
  if (r.previous) ctx.out(`The previous database was kept as ${r.previous}`);
  if (r.migrationLevel < LATEST_MIGRATION) {
    ctx.out("Migrations to the current schema run when the coordinator next starts.");
  }
}

export function coordinatorMigrate(ctx: Ctx, flags: { dataDir?: string }): void {
  const dataDir = dataDirOf(flags, ctx.env);
  const holder = lockHolder(dataDir);
  if (holder !== null) {
    throw new CliError(
      `Coordinator (pid ${holder}) is running on ${dataDir}; it migrated at start`,
    );
  }
  const path = dbPath(dataDir);
  const existed = existsSync(path);
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(path);
  try {
    const before = existed ? migrationLevel(db) : 0;
    migrate(db);
    const after = migrationLevel(db);
    ctx.out(
      before === after
        ? `Schema is current (level ${after}) at ${path}`
        : `Migrated ${path} from level ${before} to ${after}`,
    );
  } finally {
    db.close();
  }
}
