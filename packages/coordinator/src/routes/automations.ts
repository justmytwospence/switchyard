import { AutomationInput, newId, SwitchyardError } from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { filtersMatch } from "../automations/service.js";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";

const ListQuery = z.object({ projectId: z.string().optional() });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) });
/** Webhook bodies are capped at 256 KB. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;

export function registerAutomationRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const svc = () => requireService(ctx, "automations");
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  /** Automation plus its human-readable trigger summary. */
  const view = (id: string) => {
    const a = store.automations.require(id);
    return { ...a, summary: svc().describe(a) };
  };

  app.get("/api/automations", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const list = q.projectId
      ? store.automations.list("project_id = ?", [q.projectId], "created_at")
      : store.automations.list(undefined, [], "created_at");
    return list.map((a) => ({ ...a, summary: svc().describe(a) }));
  });

  app.post("/api/automations", async (req, reply) => {
    const a = svc().create(validated(req.body));
    return reply.code(201).send(view(a.id));
  });

  app.get("/api/automations/:id", async (req) => view(idOf(req)));

  app.patch("/api/automations/:id", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new SwitchyardError("invalid_request", "Expected an object");
    }
    svc().update(idOf(req), body);
    return view(idOf(req));
  });

  app.delete("/api/automations/:id", async (req) => {
    svc().delete(idOf(req));
    return { ok: true };
  });

  app.get("/api/automations/:id/preview", async (req) =>
    svc().preview(store.automations.require(idOf(req))),
  );

  /** Preview an unsaved draft (editor "Preview resulting task"). */
  app.post("/api/automations/preview", async (req) => {
    const input = validated(req.body);
    const now = store.nowIso();
    return svc().preview({
      id: "aut_preview",
      ...input,
      nextAt: null,
      lastEvaluatedAt: null,
      lastOutcome: null,
      failureCount: 0,
      webhookTokenSet: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  /** Manual fire. */
  app.post("/api/automations/:id/run", async (req, reply) => {
    const a = store.automations.require(idOf(req));
    const r = svc().fire(a.id, {
      key: `manual:${newId("occ")}`,
      scheduledFor: null,
      payload: (req.body as unknown) ?? {},
    });
    return reply.code(201).send({ occurrence: r.occurrence, task: r.task });
  });

  app.get("/api/automations/:id/history", async (req) => {
    const q = parse(HistoryQuery, req.query, "query");
    return svc().history(idOf(req), q.limit);
  });

  /** Rotate the webhook token. The token is returned once; only its sha256 is stored. */
  app.post("/api/automations/:id/webhook-token", async (req, reply) => {
    store.automations.require(idOf(req));
    return reply.code(201).send(svc().rotateWebhookToken(idOf(req)));
  });

  /** Authenticated webhook (bearer token, not device auth). */
  app.post("/api/hooks/:automationId", { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
    const { automationId } = req.params as { automationId: string };
    const header = req.headers.authorization ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? null;
    if (!svc().verifyWebhookToken(automationId, token)) {
      throw new SwitchyardError("unauthorized", "Invalid webhook token");
    }
    const a = store.automations.require(automationId);
    if (a.trigger.kind !== "webhook") {
      throw new SwitchyardError("conflict", "This automation is not triggered by webhooks");
    }
    if (!a.enabled) throw new SwitchyardError("conflict", "This automation is disabled");
    const idem =
      headerValue(req.headers["idempotency-key"]) ?? headerValue(req.headers["x-github-delivery"]);
    const key = `hook:${idem ?? newId("occ")}`;
    const payload = req.body ?? {};
    const match = filtersMatch(a.filters, payload);
    const r = svc().fire(
      a.id,
      match.ok
        ? { key, scheduledFor: null, payload }
        : { key, scheduledFor: null, record: { state: "filtered", reason: match.reason } },
    );
    return reply.code(202).send({
      occurrenceId: r.occurrence.id,
      state: r.occurrence.state,
      ...(r.duplicate ? { duplicate: true } : {}),
    });
  });
}

function headerValue(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim().slice(0, 200) : null;
}

/** Validate a create/preview body into an `AutomationInput` (400 on failure). */
function validated(body: unknown) {
  return parse(AutomationInput, body);
}
