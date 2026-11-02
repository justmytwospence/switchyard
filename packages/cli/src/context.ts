import type { FetchLike } from "@switchyard/terminal";
import { ApiClient } from "@switchyard/terminal";
import { type Connection, type ConnectionFlags, resolveConnection } from "./config.js";
import type { Env } from "./paths.js";

/** Everything a command handler touches outside its arguments, injectable for tests. */
export interface Ctx {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Env;
  fetch: FetchLike;
  /** Override paths for tests. */
  paths?: { clientConfig?: string; dataDir?: string; home?: string };
}

export function defaultCtx(): Ctx {
  return {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    env: process.env,
    fetch: (input, init) => fetch(input, init),
  };
}

export function connect(ctx: Ctx, flags: ConnectionFlags): { api: ApiClient; conn: Connection } {
  const conn = resolveConnection(flags, ctx.env, ctx.paths);
  return {
    conn,
    api: new ApiClient({ coordinatorUrl: conn.url, credential: conn.credential, fetch: ctx.fetch }),
  };
}

/** Render rows as an aligned plain-text table. */
export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

export function printList(
  ctx: Ctx,
  json: boolean | undefined,
  data: unknown,
  headers: string[],
  rows: string[][],
  empty: string,
): void {
  if (json) {
    ctx.out(JSON.stringify(data, null, 2));
    return;
  }
  if (rows.length === 0) {
    ctx.out(empty);
    return;
  }
  for (const l of table(headers, rows)) ctx.out(l);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
