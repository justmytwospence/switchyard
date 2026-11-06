import { describe, expect, it } from "vitest";
import { readUsage, type UsageDeps } from "../src/usage.js";

const NOW = Date.parse("2026-11-01T10:00:00.000Z");

function deps(
  auth: unknown,
  respond: (url: string, init: RequestInit) => Response,
  calls: { url: string; init: RequestInit }[] = [],
  now = () => NOW,
): UsageDeps {
  return {
    authPath: "/auth.json",
    now,
    readFile: async () => {
      if (auth === undefined) throw new Error("ENOENT");
      return typeof auth === "string" ? auth : JSON.stringify(auth);
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const AUTH = {
  anthropic: { type: "oauth", access: "a-token", expires: NOW + 60_000 },
  "openai-codex": { type: "oauth", access: "c-token", expires: NOW + 60_000, accountId: "acct_1" },
};

describe("readUsage", () => {
  it("maps both providers and drops unknown codex windows", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const out = await readUsage(
      deps(
        AUTH,
        (url) =>
          url.includes("anthropic")
            ? json({
                five_hour: { utilization: 63, resets_at: "2026-11-01T12:00:00Z" },
                seven_day: { utilization: 19, resets_at: null },
              })
            : json({
                rate_limit: {
                  primary_window: {
                    used_percent: 10,
                    reset_at: 1_793_000_000,
                    limit_window_seconds: 18000,
                  },
                  secondary_window: {
                    used_percent: 50,
                    reset_at: 1_793_000_000,
                    limit_window_seconds: 3600,
                  },
                },
              }),
        calls,
      ),
    );
    expect(out.map((u) => [u.provider, u.status])).toEqual([
      ["anthropic", "available"],
      ["openai-codex", "available"],
    ]);
    expect(out[0]?.windows).toEqual([
      { id: "five_hour", usedPct: 63, resetsAt: "2026-11-01T12:00:00Z" },
      { id: "weekly", usedPct: 19, resetsAt: null },
    ]);
    expect(out[1]?.windows).toHaveLength(1);
    expect(out[1]?.windows[0]).toMatchObject({ id: "five_hour", usedPct: 10 });
    const a = calls.find((c) => c.url.includes("anthropic"))?.init.headers as Record<
      string,
      string
    >;
    expect(a["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(a.Authorization).toBe("Bearer a-token");
    const c = calls.find((x) => x.url.includes("chatgpt"))?.init.headers as Record<string, string>;
    expect(c["ChatGPT-Account-Id"]).toBe("acct_1");
  });

  it("does not fetch with an expired token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const out = await readUsage(
      deps({ anthropic: { type: "oauth", access: "x", expires: NOW - 1 } }, () => json({}), calls),
    );
    expect(out[0]).toMatchObject({ status: "expired", message: "Sign in again in Pi" });
    expect(calls).toHaveLength(0);
  });

  it("reports rejected on 401", async () => {
    const out = await readUsage(deps({ anthropic: AUTH.anthropic }, () => json({}, 401)));
    expect(out[0]).toMatchObject({ status: "rejected" });
  });

  it("reuses the last result after a 429 until Retry-After passes", async () => {
    let now = NOW;
    let n = 0;
    const d = deps(
      { anthropic: { ...AUTH.anthropic, expires: NOW + 10_000_000 } },
      () => {
        n += 1;
        return n === 1
          ? json({ five_hour: { utilization: 1 } })
          : n === 2
            ? json({}, 429, { "retry-after": "900" })
            : json({ five_hour: { utilization: 2 } });
      },
      [],
      () => now,
    );
    const last = new Map();
    const backoff = new Map();
    await readUsage(d, last, backoff);
    now += 1000;
    const limited = await readUsage(d, last, backoff);
    expect(limited[0]?.message).toBe("HTTP 429");
    now += 10_000;
    const reused = await readUsage(d, last, backoff);
    expect(n).toBe(2);
    expect(reused[0]?.message).toBe("HTTP 429");
    now += 900_000;
    const fresh = await readUsage(d, last, backoff);
    expect(n).toBe(3);
    expect(fresh[0]?.status).toBe("available");
  });

  it("returns [] for a missing file and ignores api keys", async () => {
    expect(await readUsage(deps(undefined, () => json({})))).toEqual([]);
    expect(
      await readUsage(deps({ anthropic: { type: "api_key", key: "k" } }, () => json({}))),
    ).toEqual([]);
  });
});
