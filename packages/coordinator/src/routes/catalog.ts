import { CatalogAccountType } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { requireService } from "../services.js";

const Begin = z.strictObject({
  account: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  accountType: CatalogAccountType,
});
const Complete = z.strictObject({
  state: z.string().min(1).max(128),
  code: z.string().min(1).max(512),
});
const Resolve = z.strictObject({ externalId: z.string().min(1), projectId: z.string().min(1) });

export function registerCatalogRoutes(app: FastifyInstance, ctx: CoordinatorContext) {
  const catalog = () => requireService(ctx, "catalog");
  const base = "/api/catalog/connections";
  app.get(base, async (_, reply) => {
    reply.header("Cache-Control", "no-store");
    return catalog().status();
  });
  app.post(`${base}/begin`, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { account, accountType } = parse(Begin, req.body);
    return catalog().begin(deviceOf(req).id, account, accountType);
  });
  app.post(`${base}/complete`, async (req, reply) => {
    const { state, code } = parse(Complete, req.body);
    await catalog().complete(deviceOf(req).id, state, code);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/refresh`, async (req) => {
    await catalog().refresh(req.params.id);
    return catalog().status();
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/disconnect`, async (req, reply) => {
    await catalog().disconnect(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/resolve-history`, async (req, reply) => {
    const { externalId, projectId } = parse(Resolve, req.body);
    catalog().resolveHistory(req.params.id, externalId, projectId);
    return reply.code(204).send();
  });
}
