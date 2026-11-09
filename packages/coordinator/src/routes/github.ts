import { GitHubLogsRequest, GitHubMergeRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";

/** Device-authenticated, workspace-resolved actions; the SHA-bearing POST is explicit confirmation. */
export function registerGitHubRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/workspaces/:id/pr", async (req) =>
    requireService(ctx, "github").view((req.params as { id: string }).id),
  );
  app.post("/api/workspaces/:id/pr/refresh", async (req) => {
    parse(z.object({}).strict(), req.body);
    return requireService(ctx, "github").refresh((req.params as { id: string }).id, true);
  });
  app.post("/api/workspaces/:id/pr/failed-logs", async (req) => {
    const body = parse(GitHubLogsRequest, req.body);
    return requireService(ctx, "github").failedLogs(
      (req.params as { id: string }).id,
      body.expectedHeadOid,
    );
  });
  app.post("/api/workspaces/:id/pr/merge", async (req) => {
    const body = parse(GitHubMergeRequest, req.body);
    return requireService(ctx, "github").merge(
      (req.params as { id: string }).id,
      body.expectedHeadOid,
    );
  });
}
