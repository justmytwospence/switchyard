import { OpenBranchRequest } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { openBranch } from "../branches.js";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";

/** Branches: open a project's branch in one step (see docs/model.md). */
export function registerBranchRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.post("/api/branches/open", async (req, reply) => {
    const body = parse(OpenBranchRequest, req.body);
    const result = await openBranch(ctx, body);
    return reply.code(result.created ? 202 : 200).send(result);
  });
}
