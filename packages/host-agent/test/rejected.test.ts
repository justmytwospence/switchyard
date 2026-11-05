import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { type HostAgentHandle, runHostAgent } from "../src/main.js";
import { FakeCoordinator, sleep, tempDir } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start(rejectWith: {
  code: string;
  message: string;
}): Promise<{ coord: FakeCoordinator; agent: HostAgentHandle; lines: string[] }> {
  const coord = await FakeCoordinator.start();
  coord.rejectWith = rejectWith;
  const state = tempDir();
  const lines: string[] = [];
  const agent = await runHostAgent({
    config: {
      coordinatorUrl: coord.url,
      hostId: "hst_test",
      credential: "secret",
      name: "test host",
    },
    configPath: join(state.path, "host.json"),
    stateDir: state.path,
    env: { PI_CODING_AGENT_DIR: join(state.path, "no-pi") },
    ownerAdapterDir: join(state.path, "owner-adapters"),
    handleSignals: false,
    backoffMs: [50, 100, 200],
    terminalSessions: false,
    logger: createLogger({
      level: "error",
      destination: {
        write: (s: string) => {
          lines.push(s);
        },
      },
    }),
  });
  cleanups.push(async () => {
    await agent.stop({ terminals: "stop" }).catch(() => {});
    await coord.close();
    state.cleanup();
  });
  return { coord, agent, lines };
}

describe("rejected host credential", () => {
  it("stops reconnecting and names the re-enroll command after an auth rejection", async () => {
    const { coord, agent, lines } = await start({
      code: "unauthorized",
      message: "Unknown host credential",
    });
    const rejection = await Promise.race([
      agent.rejected,
      sleep(5000).then(() => {
        throw new Error("not rejected within 5 s");
      }),
    ]);
    expect(rejection).toMatchObject({ code: "unauthorized" });
    await sleep(800);
    expect(coord.hellos.length).toBe(1);
    expect(agent.link.connected).toBe(false);
    expect(lines.some((l) => l.includes("switchyard host enroll --coordinator"))).toBe(true);
  });

  it("keeps retrying after a protocol refusal", async () => {
    const { coord } = await start({
      code: "invalid_request",
      message: "Unsupported protocol version",
    });
    await coord.waitUntil(() => coord.hellos.length >= 3, 10000, "three hellos");
  });
});
