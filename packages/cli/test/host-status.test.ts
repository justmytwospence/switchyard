import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostStatus } from "../src/commands/host.js";
import { writeClientConfig } from "../src/config.js";
import { stubFetch, testCtx } from "./helpers.js";

function setup(routes: Parameters<typeof stubFetch>[0] = {}) {
  const { fetch, calls } = stubFetch({ "GET /healthz": () => ({ ok: true }), ...routes });
  const ctx = testCtx(fetch, { SWITCHYARD_PI_BIN: "/nonexistent/pi" });
  const config = join(ctx.dir, "host.json");
  writeFileSync(
    config,
    JSON.stringify({
      coordinatorUrl: "http://dev:7400",
      hostId: "hst_1",
      credential: "c",
      name: "mac",
    }),
  );
  return { ctx, calls, config };
}

async function statusJson(
  ctx: ReturnType<typeof testCtx>,
  flags: Parameters<typeof hostStatus>[1],
) {
  await hostStatus(ctx, { ...flags, json: true });
  return JSON.parse(ctx.lines.join("\n")) as Record<string, any>;
}

describe("host status", () => {
  it("does not ask another coordinator about this host", async () => {
    const { ctx, calls, config } = setup();
    writeClientConfig(ctx.paths!.clientConfig!, {
      coordinatorUrl: "https://prod",
      credential: "prodcred",
    });
    const s = await statusJson(ctx, { config, stateDir: ctx.dir });
    expect(calls.some((c) => c.path.startsWith("/api/hosts"))).toBe(false);
    expect(s.connectivity).toBe("unknown");
    expect(s.connectivityNote).toMatch(/no client credential for http:\/\/dev:7400/);
  });

  it("asks the host's own coordinator with the client credential", async () => {
    const { ctx, calls, config } = setup({
      "GET /api/hosts/hst_1": () => ({ connectivity: "connected", lastSeenAt: null }),
    });
    writeClientConfig(ctx.paths!.clientConfig!, {
      coordinatorUrl: "http://dev:7400",
      credential: "devcred",
    });
    const s = await statusJson(ctx, { config, stateDir: ctx.dir });
    expect(calls.find((c) => c.path === "/api/hosts/hst_1")?.auth).toBe("Bearer devcred");
    expect(s.connectivity).toBe("connected");
  });

  it("--instance needs --config and --state-dir and names that service", async () => {
    const { ctx, config } = setup();
    await expect(hostStatus(ctx, { instance: "dev", json: true })).rejects.toThrow(
      /--instance needs --config/,
    );
    const s = await statusJson(ctx, { instance: "dev", config, stateDir: ctx.dir });
    expect(s.service.file).toMatch(/dev/);
    expect(s.instance).toBe("dev");
  });
});
