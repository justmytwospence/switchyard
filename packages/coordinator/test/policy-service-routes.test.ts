import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorContext } from "../src/context.js";
import { installErrorHandler } from "../src/http.js";
import { registerPolicyRoutes } from "../src/routes/policies.js";

let app: FastifyInstance;
const service = {
  listRules: vi.fn(() => []),
  createRule: vi.fn(async (body: unknown) => body),
  updateRule: vi.fn(async (_id: string, body: unknown) => body),
  deleteRule: vi.fn(),
  test: vi.fn(async () => ({ verdict: "ALLOW" })),
  settings: vi.fn(() => ({ revision: 1, modelClassifications: [] })),
  updateSettings: vi.fn((body: unknown) => body),
};
beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  installErrorHandler(app);
  // Authentication belongs to server.ts; these routes must remain behind its existing hook.
  registerPolicyRoutes(app, {
    services: new Map([["policies", service]]),
  } as unknown as CoordinatorContext);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("policy service routes", () => {
  it("exposes CRUD and forwards mutations to the validating service", async () => {
    expect((await app.inject({ method: "GET", url: "/api/policies" })).json()).toEqual([]);
    const body = {
      scope: "server",
      scopeId: null,
      priority: 0,
      enabled: true,
      phases: ["request"],
      name: "Rule",
      expression: "null",
    };
    const created = await app.inject({ method: "POST", url: "/api/policies", payload: body });
    expect(created.statusCode).toBe(201);
    expect(service.createRule).toHaveBeenCalledWith(body);
    const patch = { expectedRevision: 1, enabled: false };
    expect(
      (await app.inject({ method: "PATCH", url: "/api/policies/rule", payload: patch })).statusCode,
    ).toBe(200);
    expect(service.updateRule).toHaveBeenCalledWith("rule", patch);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/policies/rule?expectedRevision=2" }))
        .statusCode,
    ).toBe(200);
    expect(service.deleteRule).toHaveBeenCalledWith("rule", 2);
  });
  it.each(["", "0", "-1", "1.5", "1e3", "9007199254740992", "hello"])(
    "rejects invalid delete revision %s",
    async (revision) => {
      const result = await app.inject({
        method: "DELETE",
        url: `/api/policies/rule?expectedRevision=${revision}`,
      });
      expect(result.statusCode).toBe(400);
      expect(service.deleteRule).not.toHaveBeenCalled();
    },
  );
  it("validates tester shape and settings and keeps fixed routes distinct from :id", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/policies/settings" })).json(),
    ).toMatchObject({ revision: 1 });
    const settings = { expectedRevision: 1, modelClassifications: [] };
    expect(
      (await app.inject({ method: "PUT", url: "/api/policies/settings", payload: settings }))
        .statusCode,
    ).toBe(200);
    expect(service.updateSettings).toHaveBeenCalledWith(settings);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/policies/test",
          payload: {
            sessionId: "ses_test",
            phase: "tool_call",
            tool: { name: "read", args: {} },
            request: null,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.test).toHaveBeenCalledOnce();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/policies/test",
          payload: {
            sessionId: "ses_test",
            phase: "tool_call",
            tool: { name: "read", args: {} },
            request: null,
            session: { controlMode: "human" },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(service.test).toHaveBeenCalledOnce();
  });
});
