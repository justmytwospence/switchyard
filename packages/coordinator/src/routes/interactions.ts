import {
  AnswerRequest,
  AnswerResult,
  InteractionState,
  SwitchyardError,
} from "@switchyard/protocol";
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
      params.push(InteractionState.safeParse(q.state).data ?? q.state);
    }
    return ctx.store.interactions.list(where.join(" AND ") || undefined, params, "created_at");
  });

  app.get("/api/interactions/:id", async (req) =>
    ctx.store.interactions.require((req.params as { id: string }).id),
  );

  /**
   * Answer through the host (authoritative). 200 `{status: "answered", interaction}` or 409
   * `already_answered` with `details.interaction`. Never resolves optimistically. An unsupported
   * interaction accepts one of its alternatives (`action` `abort` or `message`) once.
   */
  app.post("/api/interactions/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(AnswerRequest, req.body);
    const device = deviceOf(req);
    const interaction = ctx.store.interactions.require(id);
    // Unsupported (terminal-only) dialogs offer alternatives (stop, message) until one is chosen.
    const answerable =
      interaction.state === "pending" ||
      (interaction.state === "unsupported" && !interaction.resolution);
    if (!answerable) {
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
    // interaction.updated event arrives later (identical events are not re-appended). A newer
    // revision projected first wins: a late receipt never regresses it.
    const latest = ctx.store.tx(() => {
      const cur = ctx.store.interactions.get(id);
      if (!cur) return result.interaction;
      if (cur.revision > result.interaction.revision) return cur;
      if (JSON.stringify(cur) !== JSON.stringify(result.interaction)) {
        ctx.store.putInteraction(result.interaction, {
          hostId: session.hostId,
          projectId: session.projectId ?? undefined,
        });
        ctx.hostHub.reconcileInputAttention(result.interaction);
      }
      return result.interaction;
    });
    if (result.status === "already_answered") {
      throw new SwitchyardError("already_answered", "This question was already answered", {
        interaction: latest,
      });
    }
    return { ...result, interaction: latest };
  });
}
