import { AnswerRequest, AnswerResult, SwitchyardError } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { requireConnected } from "../sessions/service.js";

const ListQuery = z.object({
  sessionId: z.string().optional(),
  state: z.string().optional(),
});

export function registerInteractionRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/api/interactions", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const where: string[] = [];
    const params: string[] = [];
    if (q.sessionId) {
      where.push("session_id = ?");
      params.push(q.sessionId);
    }
    if (q.state) {
      where.push("state = ?");
      params.push(q.state);
    }
    return ctx.store.interactions.list(where.join(" AND ") || undefined, params, "created_at");
  });

  app.get("/api/interactions/:id", async (req) =>
    ctx.store.interactions.require((req.params as { id: string }).id),
  );

  /**
   * Answer through the host (authoritative). 200 `{status: "answered", interaction}` or 409
   * `already_answered` with `details.interaction`. Never resolves optimistically.
   */
  app.post("/api/interactions/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(AnswerRequest, req.body);
    const device = deviceOf(req);
    const interaction = ctx.store.interactions.require(id);
    if (interaction.state !== "pending") {
      throw new SwitchyardError("already_answered", "This question was already answered", {
        interaction,
      });
    }
    const session = ctx.store.sessions.require(interaction.sessionId);
    requireConnected(ctx, session.hostId);
    const raw = await ctx.hostHub.request(session.hostId, {
      type: "session.answer",
      sessionId: session.id,
      interactionId: id,
      revision: body.revision,
      response: body.response,
      deviceId: device.id,
    });
    const result = AnswerResult.parse(raw);
    // Apply the host's view now so this response and the store agree, even if the host's
    // interaction.updated event arrives later (identical events are not re-appended).
    ctx.store.tx(() => {
      const cur = ctx.store.interactions.get(id);
      if (cur && JSON.stringify(cur) !== JSON.stringify(result.interaction)) {
        ctx.store.putInteraction(result.interaction, {
          hostId: session.hostId,
          projectId: session.projectId ?? undefined,
        });
        ctx.hostHub.reconcileInputAttention(result.interaction);
      }
    });
    if (result.status === "already_answered") {
      throw new SwitchyardError("already_answered", "This question was already answered", {
        interaction: result.interaction,
      });
    }
    return result;
  });
}
