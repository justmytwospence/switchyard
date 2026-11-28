import { IssueStatusRequest, LinkIssueRequest, OpenIssueRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";

/** Tracked issues: the issues a scope's GitHub source follows (see docs/scopes.md). */
export function registerIssueRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const service = () => requireService(ctx, "scopeSources");
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/issues", async () => store.issues.list(undefined, [], "created_at, rowid"));

  app.get("/api/issues/:id/description", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return service().describeIssue(idOf(req));
  });

  app.post("/api/issues/:id/open", async (req, reply) => {
    const body = parse(OpenIssueRequest, req.body ?? {});
    const result = await service().openIssue(idOf(req), body);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.post("/api/issues/:id/link", async (req) => {
    const body = parse(LinkIssueRequest, req.body);
    return service().linkIssue(idOf(req), body.workspaceId);
  });

  app.delete("/api/issues/:id/link", async (req) => service().unlinkIssue(idOf(req)));

  app.post("/api/issues/:id/status", async (req) => {
    const body = parse(IssueStatusRequest, req.body);
    return service().setStatus(idOf(req), body.status);
  });
}
