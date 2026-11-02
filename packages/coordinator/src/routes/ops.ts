import type { FastifyInstance } from "fastify";
import { COORDINATOR_VERSION, type CoordinatorContext } from "../context.js";
import { LATEST_MIGRATION, migrationLevel } from "../db/index.js";
import { VERSIONS } from "../ops.js";

export function registerOpsRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      ctx.store.db.prepare("SELECT 1").get();
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({
        error: { code: "internal", message: `Database not ready: ${String(err)}` },
      });
    }
  });

  app.get("/api/diagnostics", async () => {
    const range = ctx.store.eventSeqRange();
    return {
      versions: { coordinator: COORDINATOR_VERSION, ...VERSIONS },
      migrationLevel: migrationLevel(ctx.store.db),
      latestMigration: LATEST_MIGRATION,
      publicUrl: ctx.config.publicUrl,
      hosts: ctx.store.hosts.list(undefined, [], "created_at").map((h) => ({
        id: h.id,
        name: h.name,
        agentVersion: h.agentVersion,
        piVersion: h.piVersion,
        piCompatible: h.piCompatible,
        connectivity: h.connectivity,
        lastSeenAt: h.lastSeenAt,
        revokedAt: h.revokedAt,
        unsupported: h.capabilities?.unsupported ?? [],
      })),
      adapters: ctx.store.adaptersByHost(),
      diagnostics: ctx.store
        .latestEvents("diagnostic", 100)
        .map((e) => ({ seq: e.seq, hostId: e.hostId ?? null, ...(e.data as object) })),
      events: {
        minSeq: range.min,
        maxSeq: range.max,
        currentSeq: ctx.store.currentSeq(),
        minRetainedSeq: ctx.store.minRetainedSeq(),
        retentionDays: ctx.store.retentionDays,
      },
      push: {
        vapidConfigured: ctx.store.getSetting<unknown>("vapid", null) !== null,
        subscriptions: ctx.store.listPushSubscriptions().length,
      },
      clients: { connectedDevices: ctx.clientHub.connectedDeviceIds().length },
    };
  });
}
