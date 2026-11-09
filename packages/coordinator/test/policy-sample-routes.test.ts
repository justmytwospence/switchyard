import { request as httpRequest } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorContext } from "../src/context.js";
import { installErrorHandler } from "../src/http.js";
import { registerPolicyRoutes } from "../src/routes/policies.js";

const payload = {
  sessionId: "ses_sample",
  phase: "tool_call",
  tool: { name: "bash", args: { command: "touch /not-executed; rm -rf /outside" } },
  request: null,
};
const result = {
  verdict: "ASK",
  reason: "Sample only",
  trace: [],
  proposedStateUpdates: {},
  enforcement: { phases: ["tool_call", "request"], modelRequest: false, explanation: "" },
};
let app: FastifyInstance;
let service: { test: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  app = Fastify();
  installErrorHandler(app);
  service = { test: vi.fn(async () => result) };
  registerPolicyRoutes(app, {
    services: new Map([["policies", service]]),
  } as unknown as CoordinatorContext);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("read-only policy sample route", () => {
  it("forwards strict samples with a live cancellation signal and never returns an approval", async () => {
    const response = await app.inject({ method: "POST", url: "/api/policies/test", payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.json()).not.toHaveProperty("interactionId");
    expect(service.test).toHaveBeenCalledWith(payload, { signal: expect.any(AbortSignal) });
    // Fastify has completed the response: normal stream closure must not cancel it.
    const signal = service.test.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
  });

  it.each([
    { safety: { destructiveDelete: false } },
    { boundary: { cwdReal: "/" } },
    { runtimeId: "forged-runtime" },
    { hostId: "hst_forged" },
  ])("rejects authoritative context supplied by the device: %j", async (extra) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/policies/test",
      payload: { ...payload, ...extra },
    });
    expect(response.statusCode).toBe(400);
    expect(service.test).not.toHaveBeenCalled();
  });

  it("aborts a pending classification when the HTTP client disconnects", async () => {
    let entered!: (signal: AbortSignal) => void;
    const invocation = new Promise<AbortSignal>((resolve) => {
      entered = resolve;
    });
    let canceled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    service.test.mockImplementation(async (_raw, { signal }: { signal: AbortSignal }) => {
      entered(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            canceled();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = httpRequest(`${url}/api/policies/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.on("error", () => {});
    request.end(JSON.stringify(payload));
    const signal = await invocation;
    expect(signal.aborted).toBe(false);
    request.destroy();
    await cancellation;
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toMatch(/disconnected/);
  });
});
