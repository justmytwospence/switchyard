import { randomUUID } from "node:crypto";
import type { HostCommand, HostPolicySampleRequest } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  type CommandRouterOptions,
  queueKey,
  READ_CONCURRENCY,
  READ_ONLY_COMMANDS,
} from "../src/commands.js";
import { HostDb } from "../src/db/index.js";
import { silentLogger } from "../src/logger.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function command(): Extract<HostCommand, { type: "session.classifyPolicySample" }> {
  return {
    type: "session.classifyPolicySample",
    sessionId: "session",
    nativeSessionId: "native",
    runtimeId: "runtime",
    sampleId: randomUUID(),
    tool: { name: "bash", args: { command: "rm -rf /outside" } },
  };
}
function fixture(supervisor: object) {
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const router = new CommandRouter({
    db,
    supervisor: supervisor as CommandRouterOptions["supervisor"],
    dispatcher: {} as CommandRouterOptions["dispatcher"],
    workspaces: {} as CommandRouterOptions["workspaces"],
    log: silentLogger(),
    sendReceipt: vi.fn(),
  });
  return { db, router };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("policy sample command read lane", () => {
  it("bypasses a blocked prompt and forwards only the sample request, not the command discriminator", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const classifyPolicySample = vi.fn(async (request: HostPolicySampleRequest) => ({
      sampleId: request.sampleId,
    }));
    const { router } = fixture({
      prompt: () => {
        entered.resolve();
        return gate.promise;
      },
      classifyPolicySample,
    });
    const c = command();
    expect(READ_ONLY_COMMANDS.has(c.type)).toBe(true);
    expect(queueKey(c)).toBeNull();
    const running = router.handle("prompt", {
      type: "session.prompt",
      sessionId: "session",
      text: "wait",
      mode: "prompt",
      origin: "human",
      controlRevision: 1,
    });
    await entered.promise;
    try {
      expect(await router.handle(randomUUID(), c)).toMatchObject({
        ok: true,
        result: { sampleId: c.sampleId },
      });
      const { type: _type, ...request } = c;
      expect(classifyPolicySample).toHaveBeenCalledExactlyOnceWith(request);
    } finally {
      gate.resolve();
      await running;
    }
  });

  it("uses the existing bounded read concurrency, without pending mutation markers", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const classifyPolicySample = vi.fn(async () => {
      if (classifyPolicySample.mock.calls.length === READ_CONCURRENCY) started.resolve();
      await gate.promise;
      return null;
    });
    const { db, router } = fixture({ classifyPolicySample });
    const requests = Array.from({ length: READ_CONCURRENCY + 1 }, () =>
      router.handle(randomUUID(), command()),
    );
    await started.promise;
    expect(classifyPolicySample).toHaveBeenCalledTimes(READ_CONCURRENCY);
    expect(db.all("SELECT * FROM receipts")).toEqual([]);
    gate.resolve();
    expect((await Promise.all(requests)).every((r) => r.ok)).toBe(true);
    expect(classifyPolicySample).toHaveBeenCalledTimes(READ_CONCURRENCY + 1);
  });

  it("replays the same command receipt but uses fresh command/sample identities for a new read", async () => {
    const classifyPolicySample = vi.fn(async (request: HostPolicySampleRequest) => ({
      sampleId: request.sampleId,
    }));
    const { router } = fixture({ classifyPolicySample });
    const firstCommand = command();
    const id = randomUUID();
    const first = await router.handle(id, firstCommand);
    expect(await router.handle(id, firstCommand)).toEqual(first);
    expect(classifyPolicySample).toHaveBeenCalledTimes(1);
    const secondCommand = command();
    expect(await router.handle(randomUUID(), secondCommand)).toMatchObject({
      ok: true,
      result: { sampleId: secondCommand.sampleId },
    });
    expect(classifyPolicySample).toHaveBeenCalledTimes(2);
    expect(secondCommand.sampleId).not.toBe(firstCommand.sampleId);
  });
});
