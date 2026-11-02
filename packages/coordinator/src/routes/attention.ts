import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";

const ListQuery = z.object({
  includeResolved: z.enum(["true", "false"]).optional(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function registerAttentionRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/attention", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const where: string[] = [];
    const params: string[] = [];
    if (q.includeResolved !== "true") where.push("resolved_at IS NULL");
    if (q.sessionId) {
      where.push("session_id = ?");
      params.push(q.sessionId);
    }
    if (q.taskId) {
      where.push("task_id = ?");
      params.push(q.taskId);
    }
    return ctx.store.attention
      .list(where.join(" AND ") || undefined, params, "created_at DESC")
      .slice(0, q.limit);
  });

  app.post("/api/attention/:id/acknowledge", async (req) =>
    ctx.attention.acknowledge((req.params as { id: string }).id),
  );
}
