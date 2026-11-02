import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/context.js";

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

type Handler = (call: Call) => { status?: number; body: unknown } | unknown;

/** A fetch stub routing `"METHOD /path"` (path without query) to handlers; records calls. */
export function stubFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      path: u.pathname + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const h = routes[`${method} ${u.pathname}`];
    if (!h) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), {
        status: 404,
      });
    }
    const r = h(call) as { status?: number; body?: unknown };
    const isWrapped = r && typeof r === "object" && "body" in r && Object.keys(r).length <= 2;
    const status = isWrapped ? (r.status ?? 200) : 200;
    const body = isWrapped ? r.body : r;
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch: fetchImpl, calls };
}

export function testCtx(
  fetchImpl: Ctx["fetch"],
  env: Record<string, string | undefined> = {},
): Ctx & { lines: string[]; errors: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sy-cli-"));
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    env,
    fetch: fetchImpl,
    paths: { clientConfig: join(dir, "client.json"), dataDir: join(dir, "data") },
    lines,
    errors,
    dir,
  };
}

export const PROJECT = {
  id: "prj_1",
  name: "Alpha",
  repoIdentity: "x",
  defaultProfileId: null,
  defaultHostId: null,
  maxConcurrentRuns: 1,
  automationEnabled: true,
  setupCommand: null,
  checks: [],
  workspaceSharing: "single_writer",
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
};
