import {
  DeletePolicyRuleQuery,
  PolicyTestRequest,
  SwitchyardError,
  UpdatePolicySettingsRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import type { PolicyService } from "../policies/service.js";

/** All routes inherit the coordinator's authenticated-device hook; none are public. */
export function registerPolicyRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const service = (): PolicyService => {
    const registered = ctx.services.get("policies") as PolicyService | undefined;
    if (!registered)
      throw new SwitchyardError("unsupported_capability", "Policies are unavailable.");
    return registered;
  };
  const id = (request: { params: unknown }) => (request.params as { id: string }).id;
  app.get("/api/policies", async () => service().listRules());
  app.post("/api/policies", async (request, reply) => {
    const rule = await service().createRule(request.body);
    return reply.code(201).send(rule);
  });
  app.patch("/api/policies/:id", async (request) =>
    service().updateRule(id(request), request.body),
  );
  app.delete("/api/policies/:id", async (request) => {
    // Query scalars arrive as strings; enforce the protocol's safe positive revision after coercion.
    const query = request.query as Record<string, unknown>;
    const raw = query.expectedRevision;
    const parsed = parse(
      DeletePolicyRuleQuery,
      {
        ...query,
        expectedRevision: typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw,
      },
      "query",
    );
    service().deleteRule(id(request), parsed.expectedRevision);
    return { ok: true };
  });
  app.post("/api/policies/test", async (request, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Policy test client disconnected."));
    const close = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    try {
      if (request.raw.aborted || reply.raw.destroyed) abort();
      return await service().test(parse(PolicyTestRequest, request.body), {
        signal: controller.signal,
      });
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
    }
  });
  app.get("/api/policies/settings", async () => service().settings());
  app.put("/api/policies/settings", async (request) =>
    service().updateSettings(parse(UpdatePolicySettingsRequest, request.body)),
  );
}
