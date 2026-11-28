import {
  IssueStatusRequest,
  LinkIssueRequest,
  OpenIssueRequest,
  OpenRepoIssueRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";

const RepoIssueParams = z.object({
  id: z.string().min(1),
  number: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.number().int().safe().positive()),
});

/** Repository inventory and issues followed by a scope's GitHub source (see docs/scopes.md). */
export function registerIssueRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const service = () => requireService(ctx, "scopeSources");
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get("/api/issues", async () => store.issues.list(undefined, [], "created_at, rowid"));

  app.get("/api/projects/:id/issues", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const query = parse(
      z.object({ after: z.string().min(1).max(2048).optional() }).strict(),
      req.query,
      "query",
    );
    return requireService(ctx, "repositoryIssues").page(idOf(req), query.after);
  });

  app.get("/api/projects/:id/issues/:number/description", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { id, number } = parse(RepoIssueParams, req.params, "params");
    return requireService(ctx, "repositoryIssues").description(id, number);
  });

  app.post("/api/projects/:id/issues/:number/open", async (req, reply) => {
    const { id, number } = parse(RepoIssueParams, req.params, "params");
    const body = parse(OpenRepoIssueRequest.strict(), req.body ?? {});
    const result = await requireService(ctx, "repositoryIssues").open(id, number, body);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.get("/api/sessions/:id/issue-work", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return requireService(ctx, "issueWork").forSession(idOf(req));
  });

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
